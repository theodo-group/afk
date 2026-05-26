import { Effect, Layer } from "effect"
import { randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { ConfigService } from "../../services/ConfigService.ts"
import { Subprocess } from "../../infra/Subprocess.ts"
import { Output } from "../../infra/Output.ts"
import { RunHistory } from "../../services/backend/RunHistory.ts"
import { GoldenImageStore } from "../../services/backend/GoldenImage.ts"
import { CfWorker } from "./CfWorker.ts"
import {
  Compute,
  type AttachOptions,
  type PreparedRun,
  type StartInput,
} from "../../services/backend/Compute.ts"
import { CloudflareError, ConfigError, UserError } from "../../infra/Errors.ts"
import { COMPOSE_FILE, DEFAULT_MAIN_SERVICE } from "../../constants.ts"
import type { Run } from "../../schema/Run.ts"
import {
  type CloudflareBackendPlan,
  type RunMetadataWire,
  planCloudflareRun,
  toRunStarted,
  toStartRequest,
  wireToRun,
} from "./CloudflareRunPlan.ts"
import { resolveRunByIdPrefix } from "../../services/RunIdPrefix.ts"

/**
 * Cloudflare implementation of the abstract Compute tag. Every operation is
 * an HTTPS/WSS call to the launcher Worker; no CF-side state lives in the
 * CLI process. Auth is via Cloudflare Access service-token headers, sourced
 * from `AFK_CF_CLIENT_ID` / `AFK_CF_CLIENT_SECRET` env vars. In single-dev
 * (no-Access) mode the headers are simply omitted.
 */
export const CloudflareComputeLive = Layer.effect(
  Compute,
  Effect.gen(function* () {
    const cfg = yield* ConfigService
    const sub = yield* Subprocess
    const out = yield* Output
    const history = yield* RunHistory
    const golden = yield* GoldenImageStore
    const worker = yield* CfWorker

    // Owner principal for this caller (Cloudflare Access service-token client-id,
    // or "local" in single-dev / no-Access mode).
    const principalId = process.env.AFK_CF_CLIENT_ID ?? "local"

    // The Run's completion callback needs the Worker's absolute URL; resolve it
    // from config here (CfWorker owns relative-path calls, not URL exposure).
    const resolveWorkerUrl = Effect.gen(function* () {
      const { config } = yield* cfg.load
      const url = config.cloudflare?.workerUrl
      if (!url) {
        return yield* Effect.fail(
          new UserError({
            message: "cloudflare.workerUrl is not set in afk.config.json.",
            hint: "After `wrangler deploy`, set the workers.dev URL (or your custom hostname) into cloudflare.workerUrl.",
          }),
        )
      }
      return url.replace(/\/$/, "")
    })

    const prepare = (input: StartInput) =>
      Effect.gen(function* () {
        // Shell: gather the effectful inputs the core needs.
        const { config, envEntries, projectRoot, sourceRepoName } =
          yield* cfg.load
        const workerUrl = yield* resolveWorkerUrl

        // Refuse to launch if no Golden Image has been built. The agent's
        // wrapper image FROM-extends `afk-golden:*` (see PR 3's
        // wrapper-Dockerfile contract) and there is no implicit on-demand
        // build, mirroring the AWS path.
        const latestGolden = yield* golden.findLatest
        if (!latestGolden) {
          return yield* Effect.fail(
            new UserError({
              message: "No Cloudflare Golden Image found for this account.",
              hint: "Run `afk golden build` first.",
            }),
          )
        }

        const composePath = resolve(projectRoot, COMPOSE_FILE)
        const composeRaw = existsSync(composePath)
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
        const core = yield* planCloudflareRun({
          config,
          envEntries,
          sourceRepoName,
          workerUrl,
          principalId,
          composeContent: composeRaw,
          input,
          runId: randomUUID(),
          startedAt: new Date().toISOString(),
        })
        for (const w of core.warnings) yield* out.print(`warning: ${w}`)
        return core.prepared
      })

    const launch = (plan: PreparedRun) =>
      Effect.gen(function* () {
        const cf = plan.backendPlan as CloudflareBackendPlan
        const startRequest = toStartRequest(plan, cf)
        const resp = yield* worker.postJson<{
          runId: string
          resourceId: string
          status: "PROVISIONING"
          startedAt: string
        }>("POST /runs", "/runs", startRequest)

        // recordStart is a no-op on CF (Worker writes D1) but we call it so
        // the abstract RunHistory interface stays uniform.
        yield* history
          .recordStart({
            runId: plan.runId,
            owner: plan.owner,
            repo: plan.repoName,
            branch: plan.branch,
            sha: plan.sha,
            image: plan.image,
            resourceId: resp.resourceId,
            startedAt: cf.startedAt,
            timeoutHours: plan.timeoutHours,
            backendDetails: {
              instanceTier: cf.instanceTier,
            },
          })
          .pipe(Effect.catchAll(() => Effect.void))

        return toRunStarted(plan, cf, resp.resourceId)
      })

    const listMine = (_ownerUserId: string) =>
      Effect.gen(function* () {
        const { runs } = yield* worker.getJson<{
          runs: ReadonlyArray<RunMetadataWire>
        }>("GET /runs", "/runs")
        return runs.map(wireToRun)
      })

    const listAll = Effect.gen(function* () {
      const { runs } = yield* worker.getJson<{
        runs: ReadonlyArray<RunMetadataWire>
      }>("GET /runs?all=true", "/runs?all=true")
      return runs.map(wireToRun)
    })

    // Resolve via listAll + helper rather than the launcher Worker's
    // GET /runs/{id}: the single-id endpoint needs a full UUID, but `afk` accepts
    // a leading prefix so the developer can paste a short id from `afk ls`.
    const findByRunId = (
      runId: string,
    ): Effect.Effect<Run, CloudflareError | UserError | ConfigError> =>
      listAll.pipe(Effect.flatMap((runs) => resolveRunByIdPrefix(runId, runs)))

    const kill = (runId: string) =>
      Effect.gen(function* () {
        const run = yield* findByRunId(runId)
        yield* worker
          .del(
            `DELETE /runs/${run.runId}`,
            `/runs/${encodeURIComponent(run.runId)}`,
          )
          .pipe(Effect.asVoid)
      })

    /**
     * Interactive shell into a Run via `wrangler containers ssh`.
     *
     * Why SSH and not the launcher Worker: the CF Containers SDK's
     * `container.exec()` is pipe-based (no PTY/resize), so it can't host a real
     * terminal. `wrangler containers ssh` allocates a proper PTY. The Worker is
     * still used to resolve runId → instance id (Owner-scoped), but the shell
     * itself talks to Cloudflare's control plane directly — the only CF command
     * that does, hence the account-token requirement below.
     *
     * Setup the consumer must do once: add an `ssh-ed25519` key under
     * `[[containers.authorized_keys]]` in worker/afk/wrangler.toml and redeploy
     * (`afk doctor` flags this). See README "Attach".
     */
    const attach = (runId: string, opts: AttachOptions) =>
      Effect.gen(function* () {
        const { config } = yield* cfg.load
        const mainService = config.mainService ?? DEFAULT_MAIN_SERVICE

        if ((process.env.CLOUDFLARE_API_TOKEN ?? "").length === 0) {
          return yield* Effect.fail(
            new UserError({
              message:
                "CLOUDFLARE_API_TOKEN is required for `afk attach` on Cloudflare.",
              hint: "Attach shells out to `wrangler containers ssh`, which needs account-level auth. Export a token with Workers Containers:Edit and retry.",
            }),
          )
        }

        const run = yield* findByRunId(runId)
        const { instanceId } = yield* worker.getJson<{ instanceId: string }>(
          `GET /runs/${run.runId}/ssh-target`,
          `/runs/${encodeURIComponent(run.runId)}/ssh-target`,
        )

        const args = ["containers", "ssh", instanceId]
        if (!opts.host) {
          // Default/`--service`: drop into a service container rather than the
          // outer host. Locate it by its compose service label (name fallback
          // for the no-compose Run) and `docker exec` in — this avoids
          // `docker compose exec`, which would re-interpolate compose.yml and
          // warn on the unset AFK_ENV_FILE. `--host` skips this for the host.
          // LIVE-VERIFY: whether `wrangler containers ssh <id> -- <cmd>`
          // allocates a TTY for the trailing command (needed for a usable
          // shell). See IMPROVEMENTS.md #11.
          const service = opts.service ?? mainService
          const inner =
            `C=$(docker ps -qf "label=com.docker.compose.service=${service}" | head -n1); ` +
            `[ -n "$C" ] || C=$(docker ps -qf "name=^${service}$" | head -n1); ` +
            `if [ -z "$C" ]; then echo "service ${service} is not running" >&2; exit 1; fi; ` +
            `docker exec -it "$C" bash 2>/dev/null || docker exec -it "$C" sh`
          args.push("--", "sh", "-lc", inner)
        }

        yield* sub.runInteractive("wrangler", args).pipe(
          Effect.mapError(
            (e): CloudflareError =>
              new CloudflareError({
                operation: `wrangler containers ssh ${run.runId}`,
                message: e.message,
              }),
          ),
        )
      })

    const callerPrincipal = Effect.sync(() => ({
      id: principalId,
      displayName: principalId,
    }))

    return Compute.of({
      backendName: "cloudflare",
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
