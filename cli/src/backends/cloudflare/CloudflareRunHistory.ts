import { DateTime, Effect, Layer } from "effect"
import {
  RunHistory,
  type HistoryRow,
} from "../../services/backend/RunHistory.ts"
import { CfWorker } from "./CfWorker.ts"

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
    const worker = yield* CfWorker

    return RunHistory.of({
      recordStart: (_input) => Effect.void,
      recordComplete: (_input) => Effect.void,
      query: ({ since, owner, branch, limit }) =>
        Effect.gen(function* () {
          const params = new URLSearchParams()
          if (since) {
            // worker /history takes a duration; serialize the neutral instant to seconds-ago
            const now = yield* DateTime.now
            const seconds = Math.max(
              1,
              Math.round(
                (DateTime.toEpochMillis(now) - DateTime.toEpochMillis(since)) /
                  1000,
              ),
            )
            params.set("since", `${seconds}s`)
          }
          if (owner === undefined) params.set("all", "true")
          if (branch) params.set("branch", branch)
          if (limit !== undefined) params.set("limit", String(limit))
          const out = yield* worker.getJson<{
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
          }>("GET /history", `/history?${params.toString()}`)

          const rows = out.rows.map<HistoryRow>((r) => {
            let backendDetails: Record<string, string> | undefined
            if (r.backend_details) {
              try {
                const parsed = JSON.parse(r.backend_details) as Record<
                  string,
                  unknown
                >
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
              ...(r.stopped_at !== undefined
                ? { stoppedAt: r.stopped_at }
                : {}),
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
