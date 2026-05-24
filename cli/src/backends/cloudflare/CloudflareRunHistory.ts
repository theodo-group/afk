import { DateTime, Effect, Layer } from "effect"
import { RunHistory, type HistoryRow } from "../../services/backend/RunHistory.ts"
import { ConfigService } from "../../services/ConfigService.ts"
import { CloudflareError, UserError } from "../../infra/Errors.ts"

const authHeaders = (): Record<string, string> => {
  const id = process.env.AFK_CF_CLIENT_ID
  const secret = process.env.AFK_CF_CLIENT_SECRET
  const out: Record<string, string> = { "content-type": "application/json" }
  if (id) out["CF-Access-Client-Id"] = id
  if (secret) out["CF-Access-Client-Secret"] = secret
  return out
}

/**
 * Cloudflare implementation of RunHistory.
 *
 * `recordStart` and `recordComplete` are no-ops on this Backend — the launcher
 * Worker writes D1 directly when a Run is created and when its DO alarm fires.
 * `query` calls the launcher's `GET /history` endpoint, which returns rows in
 * the same shape as the D1 schema (see `worker/cloudflare/migrations/0001_runs.sql`).
 */
export const CloudflareRunHistoryLive = Layer.effect(
  RunHistory,
  Effect.gen(function* () {
    const cfg = yield* ConfigService

    const resolveWorkerUrl = Effect.gen(function* () {
      const { config } = yield* cfg.load
      const url = config.cloudflare?.workerUrl
      if (!url) {
        return yield* Effect.fail(
          new UserError({
            message: "cloudflare.workerUrl is not set in afk.config.json.",
          }),
        )
      }
      return url.replace(/\/$/, "")
    })

    return RunHistory.of({
      recordStart: (_input) => Effect.void,
      recordComplete: (_input) => Effect.void,
      query: ({ since, owner, branch, limit }) =>
        Effect.gen(function* () {
          const base = yield* resolveWorkerUrl
          const params = new URLSearchParams()
          if (since) {
            // worker /history takes a duration; serialize the neutral instant to seconds-ago
            const now = yield* DateTime.now
            const seconds = Math.max(
              1,
              Math.round((DateTime.toEpochMillis(now) - DateTime.toEpochMillis(since)) / 1000),
            )
            params.set("since", `${seconds}s`)
          }
          if (owner === undefined) params.set("all", "true")
          if (branch) params.set("branch", branch)
          if (limit !== undefined) params.set("limit", String(limit))
          const url = `${base}/history?${params.toString()}`
          const out = yield* Effect.tryPromise({
            try: async () => {
              const res = await fetch(url, { headers: authHeaders() })
              const text = await res.text()
              if (!res.ok) {
                throw new CloudflareError({
                  operation: "GET /history",
                  status: res.status,
                  message: text || res.statusText,
                })
              }
              return JSON.parse(text) as {
                rows: ReadonlyArray<{
                  run_id: string
                  owner: string
                  repo: string
                  branch?: string
                  sha?: string
                  image?: string
                  resource_id?: string
                  status: string
                  started_at: string
                  stopped_at?: string
                  exit_code?: number
                  timeout_hours: number
                  backend_details?: string
                }>
              }
            },
            catch: (e): CloudflareError =>
              e instanceof CloudflareError
                ? e
                : new CloudflareError({
                    operation: "GET /history",
                    message: String(e),
                  }),
          })

          const rows = out.rows.map<HistoryRow>((r) => {
            let backendDetails: Record<string, string> | undefined
            if (r.backend_details) {
              try {
                const parsed = JSON.parse(r.backend_details) as Record<string, unknown>
                backendDetails = Object.fromEntries(
                  Object.entries(parsed).map(([k, v]) => [k, String(v)]),
                )
              } catch {
                /* ignore malformed JSON */
              }
            }
            return {
              runId: r.run_id,
              owner: r.owner,
              repo: r.repo,
              branch: r.branch ?? "",
              sha: r.sha ?? "",
              image: r.image ?? "",
              resourceId: r.resource_id ?? "",
              status: r.status === "RUNNING" ? "RUNNING" : "STOPPED",
              startedAt: r.started_at,
              ...(r.stopped_at !== undefined ? { stoppedAt: r.stopped_at } : {}),
              ...(r.exit_code !== undefined ? { exitCode: r.exit_code } : {}),
              timeoutHours: r.timeout_hours,
              ...(backendDetails !== undefined ? { backendDetails } : {}),
            }
          })
          return rows
        }),
    })
  }),
)
