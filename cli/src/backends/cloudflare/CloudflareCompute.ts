import { Effect, Layer } from "effect"
import { randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { ConfigService } from "../../services/ConfigService.ts"
import { RunHistory } from "../../services/backend/RunHistory.ts"
import { CloudflareGoldenBuilder } from "../../services/CloudflareGoldenBuilder.ts"
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
import {
  COMPOSE_FILE,
  DEFAULT_MAIN_SERVICE,
  DEFAULT_TIMEOUT_HOURS,
} from "../../constants.ts"
import type { Run, RunStatus } from "../../schema/Run.ts"
import { lintCompose, substituteImage } from "../../services/Compose.ts"

const DEFAULT_INSTANCE_TIER = "standard-1"

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

const authHeaders = (): Record<string, string> => {
  const id = process.env.AFK_CF_CLIENT_ID
  const secret = process.env.AFK_CF_CLIENT_SECRET
  const out: Record<string, string> = { "content-type": "application/json" }
  if (id) out["CF-Access-Client-Id"] = id
  if (secret) out["CF-Access-Client-Secret"] = secret
  return out
}

const httpJson = <T>(
  operation: string,
  url: string,
  init?: RequestInit,
): Effect.Effect<T, CloudflareError> =>
  Effect.tryPromise({
    try: async (): Promise<T> => {
      const res = await fetch(url, {
        ...init,
        headers: { ...authHeaders(), ...(init?.headers ?? {}) },
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
    const history = yield* RunHistory
    const golden = yield* CloudflareGoldenBuilder

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

    const wssUrl = (https: string): string =>
      https.startsWith("https://")
        ? "wss://" + https.slice("https://".length)
        : "ws://" + https.replace(/^http:\/\//, "")

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
        const timeoutHours =
          input.timeoutHours ?? config.defaultTimeoutHours ?? DEFAULT_TIMEOUT_HOURS
        const timeoutSeconds = Math.floor(timeoutHours * 3600)

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
        const composePresent = existsSync(composePath)
        let composeContent: string | undefined
        if (composePresent) {
          const raw = yield* Effect.try({
            try: () => readFileSync(composePath, "utf8"),
            catch: (cause) =>
              new ConfigError({
                path: composePath,
                message: `cannot read: ${String(cause)}`,
              }),
          })
          const lint = yield* Effect.try({
            try: () =>
              lintCompose({ content: raw, mainService, backend: "cloudflare" }),
            catch: (e) =>
              e instanceof UserError
                ? e
                : new UserError({
                    message: `afk.compose.yml: ${String(e)}`,
                  }),
          })
          for (const w of lint.warnings) {
            console.warn(`warning: ${w}`)
          }
          composeContent = substituteImage(lint.content, built.image)
        }

        const runId = randomUUID()
        const startedAt = new Date().toISOString()

        const env: Array<{ name: string; value: string }> = envEntries
          .filter((e) => e.kind === "plain")
          .map((e) => ({ name: e.name, value: (e as { value: string }).value }))
        env.push({ name: "AFK_GIT_URL", value: config.gitUrl })
        env.push({ name: "AFK_GIT_SHA", value: built.sha })
        env.push({ name: "AFK_GIT_REF", value: input.ref ?? built.branch })
        env.push({ name: "AFK_RUN_ID", value: runId })
        env.push({ name: "AFK_TIMEOUT_SECONDS", value: String(timeoutSeconds) })

        const secrets = envEntries
          .filter((e) => e.kind === "secret")
          .map((e) => ({
            name: e.name,
            secretName: (e as { secretName: string }).secretName,
          }))

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
          composeUsed: composePresent,
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

    const start = (input: StartInput) =>
      Effect.gen(function* () {
        const plan = yield* prepare(input)
        return yield* launch(plan)
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

    const attach = (runId: string, opts: AttachOptions) =>
      Effect.gen(function* () {
        const workerUrl = yield* resolveWorkerUrl
        const params = new URLSearchParams()
        if (opts.service) params.set("service", opts.service)
        if (opts.host) params.set("host", "true")
        const q = params.toString()
        const target = `${wssUrl(workerUrl)}/runs/${encodeURIComponent(runId)}/attach${q ? `?${q}` : ""}`

        // TODO: verify WS upgrade flow with CF Access (Bun supports custom
        // headers via the second arg). On non-Access setups the headers are
        // ignored.
        yield* Effect.tryPromise({
          try: () =>
            new Promise<void>((resolveP, rejectP) => {
              // Bun exposes a global WebSocket constructor that accepts an
              // options bag with `headers` (a Bun extension).
              const WS = (globalThis as unknown as {
                WebSocket: new (url: string, opts?: { headers?: Record<string, string> }) => WebSocket
              }).WebSocket
              const ws = new WS(target, { headers: authHeaders() }) as WebSocket
              const onResize = () => {
                try {
                  ws.send(
                    JSON.stringify({
                      type: "resize",
                      cols: process.stdout.columns ?? 80,
                      rows: process.stdout.rows ?? 24,
                    }),
                  )
                } catch {
                  /* ignore */
                }
              }
              ws.onopen = () => {
                onResize()
                process.on("SIGWINCH", onResize)
                process.stdin.setRawMode?.(true)
                process.stdin.on("data", (chunk) => {
                  try {
                    ws.send(chunk)
                  } catch {
                    /* ignore */
                  }
                })
              }
              ws.onmessage = (ev: MessageEvent) => {
                const data = ev.data as unknown
                if (typeof data === "string") {
                  process.stdout.write(data)
                } else if (data instanceof ArrayBuffer) {
                  process.stdout.write(Buffer.from(data))
                } else if (data instanceof Uint8Array) {
                  process.stdout.write(Buffer.from(data))
                }
              }
              ws.onerror = (ev: Event) => {
                rejectP(
                  new CloudflareError({
                    operation: `WSS attach ${runId}`,
                    message: (ev as { message?: string }).message ?? "websocket error",
                  }),
                )
              }
              ws.onclose = () => {
                process.removeListener("SIGWINCH", onResize)
                process.stdin.setRawMode?.(false)
                resolveP()
              }
            }),
          catch: (e): CloudflareError =>
            e instanceof CloudflareError
              ? e
              : new CloudflareError({
                  operation: `WSS attach ${runId}`,
                  message: String(e),
                }),
        })
      })

    const callerPrincipal = Effect.sync(() => ({
      id: process.env.AFK_CF_CLIENT_ID ?? "local",
      displayName: process.env.AFK_CF_CLIENT_ID ?? "local",
    }))

    return Compute.of({
      backendName: "cloudflare",
      prepare,
      launch,
      start,
      listMine,
      listAll,
      findByRunId,
      kill,
      attach,
      callerPrincipal,
    })
  }),
)
