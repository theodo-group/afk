import { Context, type DateTime, Effect, Layer } from "effect"
import { RunHistory } from "./backend/RunHistory.ts"
import {
  AwsError,
  CloudflareError,
  GcpError,
  ConfigError,
  UserError,
} from "../infra/Errors.ts"

export type RunHistoryStatus = "running" | "stopped" | "failed" | "killed"

/**
 * Backwards-compatible with the pre-refactor row shape; mapped from the
 * Backend-neutral `RunHistory.HistoryRow`.
 */
export interface RunHistoryRow {
  readonly runId: string
  readonly status: RunHistoryStatus
  readonly owner: string
  readonly repo: string
  readonly branch: string
  readonly sha: string
  readonly image: string
  readonly instanceId: string
  readonly instanceType: string
  readonly spot: boolean
  readonly startedAt: string
  readonly stoppedAt?: string
  readonly exitCode?: number
  readonly timeoutHours: number
  readonly stopReason?: string
}

export interface QueryInput {
  readonly owner?: string
  readonly repo?: string
  readonly since?: DateTime.Utc
  readonly limit?: number
}

export class HistoryService extends Context.Tag("HistoryService")<
  HistoryService,
  {
    readonly query: (
      input: QueryInput,
    ) => Effect.Effect<
      ReadonlyArray<RunHistoryRow>,
      AwsError | CloudflareError | GcpError | ConfigError | UserError
    >
  }
>() {}

export const HistoryServiceLive = Layer.effect(
  HistoryService,
  Effect.gen(function* () {
    const history = yield* RunHistory

    return HistoryService.of({
      query: ({ owner, repo, since, limit }) =>
        Effect.gen(function* () {
          const rows = yield* history.query({
            ...(owner !== undefined ? { owner } : {}),
            ...(limit !== undefined ? { limit } : {}),
            ...(since !== undefined ? { since } : {}),
          })
          return rows
            .filter((r) => !repo || r.repo === repo)
            .map<RunHistoryRow>((r) => ({
              runId: r.runId,
              status:
                r.status === "RUNNING"
                  ? "running"
                  : r.exitCode === 0
                    ? "stopped"
                    : "failed",
              owner: r.owner,
              repo: r.repo,
              branch: r.branch,
              sha: r.sha,
              image: r.image,
              instanceId: r.resourceId,
              instanceType: r.backendDetails?.instanceType ?? "",
              spot: r.backendDetails?.spot === "true",
              startedAt: r.startedAt,
              ...(r.stoppedAt !== undefined ? { stoppedAt: r.stoppedAt } : {}),
              ...(r.exitCode !== undefined ? { exitCode: r.exitCode } : {}),
              timeoutHours: r.timeoutHours,
              ...(r.backendDetails?.stopReason
                ? { stopReason: r.backendDetails.stopReason }
                : {}),
            }))
        }),
    })
  }),
)
