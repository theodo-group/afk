import { Effect, Layer } from "effect"
import { randomUUID } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { type LocalBackendPlan, planLocalRun } from "./LocalRunPlan.ts"
import { userInfo } from "node:os"
import { Subprocess } from "../../infra/Subprocess.ts"
import { ConfigService } from "../../services/ConfigService.ts"
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
import { readSecretValue } from "./localSecrets.ts"
import { listAfkContainers, mapDockerState, type LocalContainer } from "./localDocker.ts"

/** Map any Subprocess/Parse failure into the seam's user-facing error channel. */
const toUserError = (op: string) => (e: { message?: string }) =>
  new UserError({ message: `local: ${op} failed: ${e.message ?? String(e)}` })

const containerToRun = (c: LocalContainer): Run | null => {
  const runId = c.labels[LABEL_RUN_ID]
  if (!runId) return null
  return {
    runId: runId as Run["runId"],
    resourceId: c.id,
    status: mapDockerState(c.state),
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

    const listAll = listAfkContainers(sub).pipe(
      Effect.map((cs) => cs.map(containerToRun).filter((r): r is Run => r !== null)),
      Effect.mapError(toUserError("docker ps")),
    )

    // Single-principal Backend: ownership scoping is a no-op, so listMine and
    // listAll are identical (see CONTEXT.md "Owner").
    const listMine = (_ownerUserId: string) => listAll

    const findByRunId = (runId: string) =>
      listAll.pipe(
        Effect.flatMap((runs) => {
          const found = runs.find((r) => r.runId === runId)
          return found
            ? Effect.succeed(found)
            : Effect.fail(
                new UserError({
                  message: `Run ${runId} not found.`,
                  hint: "Use `afk ls` to see available Runs.",
                }),
              )
        }),
      )

    const prepare = (input: StartInput) =>
      Effect.gen(function* () {
        const { config, envEntries, projectRoot, sourceRepoName } = yield* cfg.load

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
        for (const w of core.warnings) console.warn(`warning: ${w}`)
        return core.plan
      })

    const launch = (plan: PreparedRun) =>
      Effect.gen(function* () {
        const local = plan.backendPlan as LocalBackendPlan
        const { config } = yield* cfg.load
        const gitUrl = config.gitUrl

        const dir = ensureDir(runDir(plan.runId))
        ensureDir(runLogsDir(plan.runId))

        // Materialise the env file the bootstrap sources: plain vars + resolved
        // secret values (self-contained — no in-container fetch). Missing
        // secrets warn rather than fail, mirroring a misconfigured cloud Run.
        const lines: string[] = plan.env.map((e) => `${e.name}=${e.value}`)
        for (const s of plan.secrets) {
          const value = readSecretValue(gitUrl, s.secretName)
          if (value === undefined) {
            console.warn(
              `warning: secret '${s.secretName}' is not in the local store — \`afk secrets put ${s.secretName} <value>\``,
            )
            continue
          }
          lines.push(`${s.name}=${value}`)
        }
        yield* Effect.try({
          try: () =>
            writeFileSync(resolve(dir, "run.env"), lines.join("\n") + "\n", {
              mode: 0o600,
            }),
          catch: (cause) =>
            new UserError({ message: `local: could not write run.env: ${String(cause)}` }),
        })

        if (local.composeContent !== undefined) {
          yield* Effect.try({
            try: () => writeFileSync(resolve(dir, "compose.yml"), local.composeContent!),
            catch: (cause) =>
              new UserError({ message: `local: could not write compose.yml: ${String(cause)}` }),
          })
        }

        // Cross the agent image into the Run's inner daemon via save → (load in
        // bootstrap). The tar lands on the bind-mounted scratch dir.
        yield* sub
          .run("docker", ["save", "-o", resolve(dir, "agent-image.tar"), plan.image])
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
        yield* sub
          .run("docker", ["rm", "-f", run.resourceId])
          .pipe(Effect.mapError(toUserError("docker rm")))
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

        if (opts.host) {
          yield* sub
            .runInteractive("docker", ["exec", "-it", container, "sh"])
            .pipe(Effect.mapError(toUserError("docker exec")))
          return
        }

        // Nested: shell into the inner service container via the outer
        // container's own docker. The exec'd shell must point DOCKER_HOST at the
        // inner rootless socket (it doesn't inherit the bootstrap's env). compose
        // path first, then a bare `docker exec` against the service-named
        // container (the no-compose Run names its single container after the
        // main service).
        const compose = `${LOCAL_RUN_MOUNT}/compose.yml`
        const inner =
          `export DOCKER_HOST=${LOCAL_INNER_DOCKER_HOST}; ` +
          `if [ -f ${compose} ]; then ` +
          `docker compose -f ${compose} exec ${service} bash 2>/dev/null || ` +
          `docker compose -f ${compose} exec ${service} sh; ` +
          `else docker exec -it ${service} bash 2>/dev/null || docker exec -it ${service} sh; fi`

        yield* sub
          .runInteractive("docker", ["exec", "-it", container, "sh", "-lc", inner])
          .pipe(Effect.mapError(toUserError("docker exec")))
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
