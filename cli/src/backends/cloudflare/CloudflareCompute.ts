import { Effect, Layer } from "effect"
import { randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { ConfigService } from "../../services/ConfigService.ts"
import { Subprocess } from "../../infra/Subprocess.ts"
import { RunHistory } from "../../services/backend/RunHistory.ts"
import { GoldenImageStore } from "../../services/backend/GoldenImage.ts"
import {
  Compute,
  type AttachOptions,
  type PreparedRun,
  type RunStarted,
  type StartInput,
} from "../../services/backend/Compute.ts"
import {
  CloudflareError,
  ConfigError,
  UserError,
} from "../../infra/Errors.ts"
import { COMPOSE_FILE, DEFAULT_MAIN_SERVICE } from "../../constants.ts"
import type { Run, RunStatus } from "../../schema/Run.ts"
import { assembleRunPlan } from "../../services/RunPlan.ts"
import { cfAuthHeaders } from "./cfAuth.ts"

const DEFAULT_INSTANCE_TIER = "standard-1"

/** Where the golden bootstrap writes the compose file inside the Container. */
const CONTAINER_COMPOSE_PATH = "/etc/afk/compose.yml"

const mapStatus = (s: string): RunStatus => {
  switch (s) {
    case "PROVISIONING":
      return "PROVISIONING"
    case "RUNNING":
      return "RUNNING"
    case "STOPPING":
      return "STOPPING"
    default:
      return "STOPPED"
  }
}

interface CloudflareBackendPlan {
  readonly workerUrl: string
  readonly instanceTier: string
  readonly accountId?: string
  readonly startedAt: string
  readonly composeContent?: string
}

interface RunMetadataWire {
  readonly runId: string
  readonly owner: string
  readonly branch: string
  readonly sha: string
  readonly image: string
  readonly repoName: string
  readonly startedAt: string
  readonly timeoutHours: number
  readonly status: "PROVISIONING" | "RUNNING" | "STOPPING" | "STOPPED"
  readonly mainService: string
  readonly instanceTier: string
  readonly resourceId?: string
  readonly stoppedAt?: string
  readonly exitCode?: number
  readonly stopReason?: string
}

const wireToRun = (m: RunMetadataWire): Run => ({
  runId: m.runId as Run["runId"],
  resourceId: m.resourceId ?? m.runId,
  status: mapStatus(m.status),
  backend: "cloudflare",
  owner: m.owner,
  branch: m.branch,
  sha: m.sha,
  image: m.image,
  backendDetails: {
    instanceTier: m.instanceTier,
    mainService: m.mainService,
  },
  startedAt: m.startedAt,
  ...(m.stoppedAt !== undefined ? { stoppedAt: m.stoppedAt } : {}),
  ...(m.stopReason !== undefined ? { stopReason: m.stopReason } : {}),
})

const httpJson = <T>(
  operation: string,
  url: string,
  init?: RequestInit,
): Effect.Effect<T, CloudflareError> =>
  Effect.tryPromise({
    try: async (): Promise<T> => {
      const res = await fetch(url, {
        ...init,
        headers: { ...cfAuthHeaders(), ...(init?.headers ?? {}) },
      })
      const text = await res.text()
      if (!res.ok) {
        throw new CloudflareError({
          operation,
          status: res.status,
          message: text || res.statusText,
        })
      }
      return text ? (JSON.parse(text) as T) : ({} as T)
    },
    catch: (e): CloudflareError =>
      e instanceof CloudflareError
        ? e
        : new CloudflareError({ operation, message: String(e) }),
  })

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
    const history = yield* RunHistory
    const golden = yield* GoldenImageStore

    const resolveWorkerUrl = Effect.gen(function* () {
      const { config } = yield* cfg.load
      const cf = config.cloudflare
      const url = cf?.workerUrl
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
        const { config, envEntries, projectRoot, sourceRepoName } = yield* cfg.load
        const workerUrl = yield* resolveWorkerUrl

        // Refuse to launch if no Golden Image has been built. The agent's
        // wrapper image FROM-extends `afk-golden:*` (see PR 3's
        // wrapper-Dockerfile contract) and there is no implicit on-demand
        // build, mirroring the AWS path.
        const latestGolden = yield* golden.findLatest
        if (!latestGolden) {
          return yield* Effect.fail(
            new UserError({
              message:
                "No Cloudflare Golden Image found for this account.",
              hint: "Run `afk golden build` first.",
            }),
          )
        }
        const built = input.built
        const mainService = config.mainService ?? DEFAULT_MAIN_SERVICE

        const tierOverride =
          typeof input.backendOverrides?.instanceType === "string"
            ? (input.backendOverrides.instanceType as string)
            : undefined
        const instanceTier =
          tierOverride ??
          config.cloudflare?.defaultInstanceTier ??
          config.defaultInstanceType ??
          DEFAULT_INSTANCE_TIER

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

        const runId = randomUUID()
        const startedAt = new Date().toISOString()

        const assembled = assembleRunPlan({
          config,
          envEntries,
          built,
          ref: input.ref,
          timeoutHours: input.timeoutHours,
          mainService,
          backend: "cloudflare",
          composeContent: composeRaw,
          runId,
        })
        if (assembled.composeError) {
          return yield* Effect.fail(new UserError({ message: assembled.composeError }))
        }
        for (const w of assembled.warnings) console.warn(`warning: ${w}`)
        const { timeoutHours, timeoutSeconds, env, secrets, composeContent, composeUsed } =
          assembled

        const backendPlan: CloudflareBackendPlan = {
          workerUrl,
          instanceTier,
          ...(config.cloudflare?.accountId !== undefined
            ? { accountId: config.cloudflare.accountId }
            : {}),
          startedAt,
          ...(composeContent !== undefined ? { composeContent } : {}),
        }

        const plan: PreparedRun = {
          runId,
          command: input.command,
          image: built.image,
          branch: built.branch,
          sha: built.sha,
          composeUsed,
          mainService,
          timeoutHours,
          timeoutSeconds,
          owner: process.env.AFK_CF_CLIENT_ID ?? "local",
          repoName: sourceRepoName,
          env,
          secrets,
          logChannel: `Workers Logs (runId=${runId})`,
          backendPlan: backendPlan as unknown as Record<string, unknown>,
        }
        return plan
      })

    const launch = (plan: PreparedRun) =>
      Effect.gen(function* () {
        const cf = plan.backendPlan as unknown as CloudflareBackendPlan
        const startRequest = {
          runId: plan.runId,
          command: plan.command, // golden's bootstrap runs `docker run … sh -c "<command>"` inside the container

          timeoutHours: plan.timeoutHours,
          image: plan.image,
          branch: plan.branch,
          sha: plan.sha,
          mainService: plan.mainService,
          repoName: plan.repoName,
          env: plan.env,
          secretNames: plan.secrets,
          ...(cf.composeContent !== undefined ? { compose: cf.composeContent } : {}),
          instanceTier: cf.instanceTier,
          // So the container can POST its completion callback (logs + exit) back.
          workerUrl: cf.workerUrl,
        }
        const resp = yield* httpJson<{
          runId: string
          resourceId: string
          status: "PROVISIONING"
          startedAt: string
        }>("POST /runs", `${cf.workerUrl}/runs`, {
          method: "POST",
          body: JSON.stringify(startRequest),
        })

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

        const result: RunStarted = {
          runId: plan.runId,
          resourceId: resp.resourceId,
          image: plan.image,
          branch: plan.branch,
          sha: plan.sha,
          composeUsed: plan.composeUsed,
          backendDetails: {
            instanceTier: cf.instanceTier,
            mainService: plan.mainService,
          },
          logChannel: plan.logChannel,
        }
        return result
      })

    const listMine = (_ownerUserId: string) =>
      Effect.gen(function* () {
        const workerUrl = yield* resolveWorkerUrl
        const { runs } = yield* httpJson<{ runs: ReadonlyArray<RunMetadataWire> }>(
          "GET /runs",
          `${workerUrl}/runs`,
        )
        return runs.map(wireToRun)
      })

    const listAll = Effect.gen(function* () {
      const workerUrl = yield* resolveWorkerUrl
      const { runs } = yield* httpJson<{ runs: ReadonlyArray<RunMetadataWire> }>(
        "GET /runs?all=true",
        `${workerUrl}/runs?all=true`,
      )
      return runs.map(wireToRun)
    })

    const findByRunId = (
      runId: string,
    ): Effect.Effect<Run, CloudflareError | UserError | ConfigError> =>
      Effect.gen(function* () {
        const workerUrl = yield* resolveWorkerUrl
        const wire: RunMetadataWire = yield* httpJson<RunMetadataWire>(
          `GET /runs/${runId}`,
          `${workerUrl}/runs/${encodeURIComponent(runId)}`,
        ).pipe(
          Effect.catchTag(
            "CloudflareError",
            (e): Effect.Effect<RunMetadataWire, CloudflareError | UserError> =>
              e.status === 404
                ? Effect.fail(
                    new UserError({
                      message: `Run ${runId} not found.`,
                      hint: "Use `afk ls` to see available Runs.",
                    }),
                  )
                : Effect.fail(e),
          ),
        )
        return wireToRun(wire)
      })

    const kill = (runId: string) =>
      Effect.gen(function* () {
        const workerUrl = yield* resolveWorkerUrl
        yield* httpJson(`DELETE /runs/${runId}`, `${workerUrl}/runs/${encodeURIComponent(runId)}`, {
          method: "DELETE",
        })
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
        const workerUrl = yield* resolveWorkerUrl
        const mainService = config.mainService ?? DEFAULT_MAIN_SERVICE

        if ((process.env.CLOUDFLARE_API_TOKEN ?? "").length === 0) {
          return yield* Effect.fail(
            new UserError({
              message: "CLOUDFLARE_API_TOKEN is required for `afk attach` on Cloudflare.",
              hint: "Attach shells out to `wrangler containers ssh`, which needs account-level auth. Export a token with Workers Containers:Edit and retry.",
            }),
          )
        }

        const { instanceId } = yield* httpJson<{ instanceId: string }>(
          `GET /runs/${runId}/ssh-target`,
          `${workerUrl}/runs/${encodeURIComponent(runId)}/ssh-target`,
        )

        const args = ["containers", "ssh", instanceId]
        if (!opts.host) {
          // Default/`--service`: drop into a service container rather than the
          // outer host. Mirror the AWS attach fallback (compose exec → docker
          // exec, bash → sh). `--host` skips this and lands on the host shell.
          // LIVE-VERIFY: whether `wrangler containers ssh <id> -- <cmd>`
          // allocates a TTY for the trailing command (needed for a usable
          // shell). See IMPROVEMENTS.md #11.
          const service = opts.service ?? mainService
          const inner =
            `docker compose -f ${CONTAINER_COMPOSE_PATH} exec ${service} bash 2>/dev/null ` +
            `|| docker compose -f ${CONTAINER_COMPOSE_PATH} exec ${service} sh 2>/dev/null ` +
            `|| docker exec -it ${service} bash 2>/dev/null || docker exec -it ${service} sh`
          args.push("--", "sh", "-lc", inner)
        }

        yield* sub.runInteractive("wrangler", args).pipe(
          Effect.mapError(
            (e): CloudflareError =>
              new CloudflareError({
                operation: `wrangler containers ssh ${runId}`,
                message: e.message,
              }),
          ),
        )
      })

    const callerPrincipal = Effect.sync(() => ({
      id: process.env.AFK_CF_CLIENT_ID ?? "local",
      displayName: process.env.AFK_CF_CLIENT_ID ?? "local",
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
