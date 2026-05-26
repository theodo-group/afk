import { Effect, Layer, Schedule } from "effect"
import { randomUUID } from "node:crypto"
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { type LocalBackendPlan, planLocalRun } from "./LocalRunPlan.ts"
import { userInfo } from "node:os"
import { Subprocess } from "../../infra/Subprocess.ts"
import { ConfigService } from "../../services/ConfigService.ts"
import { collectionBases } from "../../services/SessionArtifact.ts"
import { GoldenImageStore } from "../../services/backend/GoldenImage.ts"
import { RunHistory } from "../../services/backend/RunHistory.ts"
import {
  Compute,
  type AttachOptions,
  type PreparedRun,
  type RunStarted,
  type StartInput,
} from "../../services/backend/Compute.ts"
import { ConfigError, UserError } from "../../infra/Errors.ts"
import {
  COMPOSE_FILE,
  DEFAULT_MAIN_SERVICE,
  DEFAULT_RETENTION_DAYS,
  LABEL_BRANCH,
  LABEL_IMAGE,
  LABEL_MAIN_SERVICE,
  LABEL_MANAGED,
  LABEL_OWNER,
  LABEL_REPO,
  LABEL_RUN_ID,
  LABEL_SHA,
  LABEL_STARTED_AT,
  LABEL_TIMEOUT_HOURS,
  LOCAL_INNER_DOCKER_HOST,
  LOCAL_OWNER_ID,
  LOCAL_RUN_MOUNT,
} from "../../constants.ts"
import type { Run } from "../../schema/Run.ts"
import { ensureDir, runDir, runLogsDir } from "./localPaths.ts"
import { isExpired, retainedUntilIso } from "../../services/retention.ts"
import { readSecretValue } from "./localSecrets.ts"
import {
  listAfkContainers,
  mapDockerState,
  type LocalContainer,
} from "./localDocker.ts"
import { resolveRunByIdPrefix } from "../../services/RunIdPrefix.ts"

/** Map any Subprocess/Parse failure into the seam's user-facing error channel. */
const toUserError = (op: string) => (e: { message?: string }) =>
  new UserError({ message: `local: ${op} failed: ${e.message ?? String(e)}` })

const containerToRun = (
  c: LocalContainer,
  retentionDays: number,
): Run | null => {
  const runId = c.labels[LABEL_RUN_ID]
  if (!runId) return null
  const status = mapDockerState(c.state)
  // A STOPPED container that still exists is a retained Run: its finishedAt +
  // retentionDays is when the reaper will reclaim it, and the timestamp's
  // presence is what marks it resumable via `afk attach`.
  const retainedUntil =
    status === "STOPPED" && c.finishedAt
      ? retainedUntilIso(c.finishedAt, retentionDays)
      : undefined
  return {
    runId: runId as Run["runId"],
    resourceId: c.id,
    status,
    backend: "local",
    owner: c.labels[LABEL_OWNER] ?? LOCAL_OWNER_ID,
    branch: c.labels[LABEL_BRANCH] ?? "",
    sha: c.labels[LABEL_SHA] ?? "",
    image: c.labels[LABEL_IMAGE] ?? "",
    backendDetails: {
      mainService: c.labels[LABEL_MAIN_SERVICE] ?? "",
    },
    startedAt: c.labels[LABEL_STARTED_AT] ?? c.startedAt,
    ...(c.finishedAt ? { stoppedAt: c.finishedAt } : {}),
    ...(retainedUntil ? { retainedUntil } : {}),
  }
}

/**
 * Local implementation of the abstract Compute tag. Each Run is one outer
 * container running rootless `dockerd`, booted from the local Golden Image, with
 * the per-Run scratch dir bind-mounted in. The host Docker daemon's `afk.*`
 * container labels are the truth source (the EC2-tag analogue), so listing /
 * finding / killing are `docker ps`/`rm` over those labels — no cloud index.
 */
export const LocalComputeLive = Layer.effect(
  Compute,
  Effect.gen(function* () {
    const sub = yield* Subprocess
    const cfg = yield* ConfigService
    const golden = yield* GoldenImageStore
    const history = yield* RunHistory

    const listAll = Effect.gen(function* () {
      const { config } = yield* cfg.load
      const retentionDays = config.retentionDays ?? DEFAULT_RETENTION_DAYS
      const cs = yield* listAfkContainers(sub).pipe(
        Effect.mapError(toUserError("docker ps")),
      )
      return cs
        .map((c) => containerToRun(c, retentionDays))
        .filter((r): r is Run => r !== null)
    })

    // Reclaim a Run's compute primitive: remove the outer container *and* its
    // anonymous inner data-root volume (-v), then drop the per-Run scratch dir.
    // The -v and the scratch-dir removal are what make reclamation complete —
    // a plain `docker rm -f` would leak both.
    const reclaim = (resourceId: string, runId: string | undefined) =>
      sub.run("docker", ["rm", "-fv", resourceId]).pipe(
        Effect.mapError(toUserError("docker rm")),
        Effect.tap(() =>
          Effect.sync(() => {
            if (runId) rmSync(runDir(runId), { recursive: true, force: true })
          }),
        ),
      )

    // Opportunistic reaper (Local has no resident supervisor): reclaim every
    // retained Run past its retention window. Best-effort — a reaping failure
    // must never block the launch it is piggybacked on.
    const reapExpired = Effect.gen(function* () {
      const { config } = yield* cfg.load
      const retentionDays = config.retentionDays ?? DEFAULT_RETENTION_DAYS
      const now = Date.now()
      const containers = yield* listAfkContainers(sub)
      const expired = containers.filter(
        (c) =>
          c.state === "exited" &&
          c.finishedAt !== "" &&
          isExpired(c.finishedAt, now, retentionDays),
      )
      yield* Effect.forEach(
        expired,
        (c) => reclaim(c.id, c.labels[LABEL_RUN_ID]),
        { discard: true },
      )
    }).pipe(Effect.catchAll(() => Effect.void))

    // Single-principal Backend: ownership scoping is a no-op, so listMine and
    // listAll are identical (see CONTEXT.md "Owner").
    const listMine = (_ownerUserId: string) => listAll

    const findByRunId = (runId: string) =>
      listAll.pipe(Effect.flatMap((runs) => resolveRunByIdPrefix(runId, runs)))

    const prepare = (input: StartInput) =>
      Effect.gen(function* () {
        const { config, envEntries, projectRoot, sourceRepoName } =
          yield* cfg.load

        const latestGolden = yield* golden.findLatest
        if (!latestGolden) {
          return yield* Effect.fail(
            new UserError({
              message: "No local Golden Image found.",
              hint: "Run `afk golden build` to build the local dind image first.",
            }),
          )
        }

        const composePath = resolve(projectRoot, COMPOSE_FILE)
        const composeContent = existsSync(composePath)
          ? yield* Effect.try({
              try: () => readFileSync(composePath, "utf8"),
              catch: (cause) =>
                new ConfigError({
                  path: composePath,
                  message: `cannot read: ${String(cause)}`,
                }),
            })
          : undefined

        // Core: pure resolution + validation. Non-deterministic seeds are
        // generated here in the shell and injected, so the core stays testable.
        const core = yield* planLocalRun({
          config,
          envEntries,
          sourceRepoName,
          goldenImageId: latestGolden.id,
          composeContent,
          input,
          runId: randomUUID(),
          startedAt: new Date().toISOString(),
        })
        yield* Effect.forEach(core.warnings, (w) => Effect.logWarning(w))
        return core.plan
      })

    const launch = (plan: PreparedRun) =>
      Effect.gen(function* () {
        // Reap expired retained Runs before adding a new one — the only moment
        // a local reaper can run (no resident supervisor; `afk ls` stays a pure
        // read). Best-effort, so a launch never fails on stale-Run cleanup.
        yield* reapExpired

        const local = plan.backendPlan as LocalBackendPlan
        const { config } = yield* cfg.load
        const gitUrl = config.gitUrl

        const dir = ensureDir(runDir(plan.runId))
        ensureDir(runLogsDir(plan.runId))

        // Materialise the env file the bootstrap sources: plain vars + resolved
        // secret values (self-contained — no in-container fetch). Missing
        // secrets warn rather than fail, mirroring a misconfigured cloud Run.
        const lines: string[] = plan.env.map((e) => `${e.name}=${e.value}`)
        const missingSecrets: string[] = []
        for (const s of plan.secrets) {
          const value = readSecretValue(gitUrl, s.secretName)
          if (value === undefined) {
            missingSecrets.push(s.secretName)
            continue
          }
          lines.push(`${s.name}=${value}`)
        }
        yield* Effect.forEach(missingSecrets, (name) =>
          Effect.logWarning(
            `secret '${name}' is not in the local store — \`afk secrets put ${name} <value>\``,
          ),
        )
        yield* Effect.try({
          try: () =>
            writeFileSync(resolve(dir, "run.env"), lines.join("\n") + "\n", {
              mode: 0o600,
            }),
          catch: (cause) =>
            new UserError({
              message: `local: could not write run.env: ${String(cause)}`,
            }),
        })

        if (local.composeContent !== undefined) {
          yield* Effect.try({
            try: () =>
              writeFileSync(resolve(dir, "compose.yml"), local.composeContent!),
            catch: (cause) =>
              new UserError({
                message: `local: could not write compose.yml: ${String(cause)}`,
              }),
          })
        }

        // Cross the agent image into the Run's inner daemon via save → (load in
        // bootstrap). The tar lands on the bind-mounted scratch dir.
        yield* sub
          .run("docker", [
            "save",
            "-o",
            resolve(dir, "agent-image.tar"),
            plan.image,
          ])
          .pipe(Effect.mapError(toUserError("docker save")))

        const name = `afk-${plan.runId.slice(0, 8)}`
        const cmdShell = plan.command.join(" ")
        const args = [
          "run",
          "-d",
          "--name",
          name,
          "-v",
          `${dir}:${LOCAL_RUN_MOUNT}`,
          // Nested dind requires --privileged even for the rootless image:
          // rootlesskit still has to mount sysfs and create its network tap
          // device inside the outer container, which an unprivileged container
          // forbids. "Rootless" buys running dockerd as non-root *inside* (and
          // lets us reuse the Cloudflare compose addenda), not the absence of
          // --privileged. This matches Docker's docs for `docker:dind-rootless`.
          "--privileged",
          "--label",
          `${LABEL_MANAGED}=true`,
          "--label",
          `${LABEL_RUN_ID}=${plan.runId}`,
          "--label",
          `${LABEL_OWNER}=${plan.owner}`,
          "--label",
          `${LABEL_BRANCH}=${plan.branch}`,
          "--label",
          `${LABEL_SHA}=${plan.sha}`,
          "--label",
          `${LABEL_REPO}=${plan.repoName}`,
          "--label",
          `${LABEL_IMAGE}=${plan.image}`,
          "--label",
          `${LABEL_TIMEOUT_HOURS}=${plan.timeoutHours}`,
          "--label",
          `${LABEL_STARTED_AT}=${local.startedAt}`,
          "--label",
          `${LABEL_MAIN_SERVICE}=${plan.mainService}`,
          "-e",
          `AFK_COMMAND=${cmdShell}`,
          "-e",
          `AFK_MAIN_SERVICE=${plan.mainService}`,
          "-e",
          `AFK_TIMEOUT_SECONDS=${plan.timeoutSeconds}`,
          "-e",
          `AFK_IMAGE=${plan.image}`,
          // Session Artifact base dirs (space-separated) for the bootstrap to
          // docker-cp out of the main service at graceful exit. Empty when the
          // dev declared none — the bootstrap no-ops on an empty value.
          "-e",
          `AFK_ARTIFACT_BASES=${collectionBases(config.sessionArtifacts ?? []).join(" ")}`,
          local.goldenImage,
        ]

        const { stdout } = yield* sub
          .run("docker", args)
          .pipe(Effect.mapError(toUserError("docker run")))
        const containerId = stdout.trim()

        yield* history
          .recordStart({
            runId: plan.runId,
            owner: plan.owner,
            repo: plan.repoName,
            branch: plan.branch,
            sha: plan.sha,
            image: plan.image,
            resourceId: containerId,
            startedAt: local.startedAt,
            timeoutHours: plan.timeoutHours,
            backendDetails: { mainService: plan.mainService },
          })
          .pipe(Effect.catchAll(() => Effect.void))

        const result: RunStarted = {
          runId: plan.runId,
          resourceId: containerId,
          image: plan.image,
          branch: plan.branch,
          sha: plan.sha,
          composeUsed: plan.composeUsed,
          backendDetails: {
            container: name,
            mainService: plan.mainService,
          },
          logChannel: plan.logChannel,
        }
        return result
      })

    const kill = (runId: string) =>
      Effect.gen(function* () {
        const run = yield* findByRunId(runId)
        yield* reclaim(run.resourceId, run.runId)
      })

    const attach = (runId: string, opts: AttachOptions) =>
      Effect.gen(function* () {
        const { config } = yield* cfg.load
        const run = yield* findByRunId(runId)
        if (run.status === "PROVISIONING") {
          return yield* Effect.fail(
            new UserError({
              message: `Run ${runId} is still PROVISIONING — wait a moment.`,
            }),
          )
        }
        const mainService = config.mainService ?? DEFAULT_MAIN_SERVICE
        const service = opts.service ?? mainService
        const container = run.resourceId

        // A finished Run is "retained": the exit marker on the mount is the
        // truth, NOT the outer container's run-state — a primitive resumed for a
        // previous attach is also "running" yet its workload has ended. So we
        // resume/commit based on the marker; a Run with no marker is live
        // (workload still in progress), and a stopped Run with no marker crashed
        // before completing and cannot be resumed.
        const retained = existsSync(resolve(runDir(runId), "exit"))
        if (!retained && run.status !== "RUNNING") {
          return yield* Effect.fail(
            new UserError({
              message: `Run ${runId} did not complete cleanly; cannot resume it.`,
              hint: "Use `afk attach <run> --host` to inspect the host, or `afk kill <run>`.",
            }),
          )
        }

        // Resume a retained primitive: start the outer container if it is parked
        // (the re-entrant bootstrap then revives the sidecars and idles — it does
        // NOT re-run the workload), then wait for the inner rootless dockerd. We
        // re-park on detach so "retained" stays the only resting state, which
        // also tidies a primitive left running by an interrupted earlier attach.
        if (retained) {
          if (run.status !== "RUNNING") {
            yield* sub
              .run("docker", ["start", container])
              .pipe(Effect.mapError(toUserError("docker start")))
          }
          // The probe must point at the inner rootless socket — `docker exec`
          // doesn't inherit the bootstrap's DOCKER_HOST, so without this it hits
          // the default socket and never succeeds.
          yield* sub
            .run("docker", [
              "exec",
              "-e",
              `DOCKER_HOST=${LOCAL_INNER_DOCKER_HOST}`,
              container,
              "docker",
              "info",
            ])
            .pipe(
              Effect.retry(
                Schedule.spaced("1 seconds").pipe(
                  Schedule.intersect(Schedule.recurs(60)),
                ),
              ),
              Effect.mapError(toUserError("resume: dockerd not ready")),
            )
        }

        // Re-park the primitive when the attach session ends (only for a
        // retained Run — never stop a live one). Never-failing so it always runs.
        const stopOuter = sub
          .run("docker", ["stop", container])
          .pipe(Effect.catchAll(() => Effect.void))

        // Locate an inner service container by its compose service label (with a
        // name fallback for the no-compose Run, whose single container is named
        // after the main service). Using the label avoids `docker compose exec`,
        // which would re-interpolate compose.yml and warn on the unset
        // AFK_ENV_FILE. `mode` is the `docker ps` filter flag: `-qf`
        // (running-only) or `-aqf` (include stopped).
        const findCid = (mode: string) =>
          `C=$(docker ps ${mode} "label=com.docker.compose.service=${service}" | head -n1); ` +
          `[ -n "$C" ] || C=$(docker ps ${mode} "name=^${service}$" | head -n1); `

        let args: ReadonlyArray<string>
        if (opts.host) {
          // The outer dind host shell.
          args = ["exec", "-it", container, "sh"]
        } else if (retained && service === mainService) {
          // The main service of a retained Run: its process has exited, so
          // `exec` is impossible. Commit its final filesystem to an image and
          // run a shell from it on host networking so it reaches the revived
          // sidecars (commit-then-run; see CONTEXT.md "Retention").
          const img = `afk-postmortem-${runId.slice(0, 8)}`
          const env = `${LOCAL_RUN_MOUNT}/run.env`
          // --entrypoint overrides the image's baked afk entrypoint (which would
          // re-clone /workspace and fail) so we land directly in a shell on the
          // committed filesystem.
          const run = (sh: string) =>
            `docker run -it --rm --network host --entrypoint ${sh} --env-file ${env} ${img}`
          const inner =
            `export DOCKER_HOST=${LOCAL_INNER_DOCKER_HOST}; ` +
            findCid("-aqf") +
            `if [ -z "$C" ]; then echo "main service container not found" >&2; exit 1; fi; ` +
            `docker commit "$C" ${img} >/dev/null && ` +
            `{ ${run("bash")} 2>/dev/null || ${run("sh")}; }; ` +
            `docker image rm ${img} >/dev/null 2>&1 || true`
          args = ["exec", "-it", container, "sh", "-lc", inner]
        } else {
          // A live main service, or a sidecar (live, or revived on resume):
          // `docker exec` into the running container located by service label.
          const inner =
            `export DOCKER_HOST=${LOCAL_INNER_DOCKER_HOST}; ` +
            findCid("-qf") +
            `if [ -z "$C" ]; then echo "service ${service} is not running" >&2; exit 1; fi; ` +
            `docker exec -it "$C" bash 2>/dev/null || docker exec -it "$C" sh`
          args = ["exec", "-it", container, "sh", "-lc", inner]
        }

        const dropIn = sub
          .runInteractive("docker", args)
          .pipe(Effect.mapError(toUserError("docker exec")))

        yield* retained ? dropIn.pipe(Effect.ensuring(stopOuter)) : dropIn
      })

    const callerPrincipal = Effect.sync(() => {
      let displayName = LOCAL_OWNER_ID
      try {
        displayName = userInfo().username
      } catch {
        /* fall back to the constant */
      }
      return { id: LOCAL_OWNER_ID, displayName }
    })

    return Compute.of({
      backendName: "local",
      prepare,
      launch,
      listMine,
      listAll,
      findByRunId,
      kill,
      attach,
      callerPrincipal,
    })
  }),
)
