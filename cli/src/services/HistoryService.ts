import { Context, Effect, Layer } from "effect"
import {
  DynamoDb,
  N,
  S,
  B,
  readB,
  readN,
  readS,
  type Item,
} from "../adapters/aws/DynamoDb.ts"
import { ConfigService } from "./ConfigService.ts"
import { AwsError, ConfigError, UserError } from "../infra/Errors.ts"
import { DEFAULT_REGION } from "../constants.ts"

const TABLE_SUFFIX = "afk-runs"

export type RunHistoryStatus = "running" | "stopped" | "failed" | "killed"

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

export interface RecordStartInput {
  readonly runId: string
  readonly owner: string
  readonly repo: string
  readonly branch: string
  readonly sha: string
  readonly image: string
  readonly instanceId: string
  readonly instanceType: string
  readonly spot: boolean
  readonly startedAt: string
  readonly timeoutHours: number
}

export interface QueryInput {
  readonly owner?: string
  readonly repo?: string
  readonly sinceIsoUtc?: string
  readonly limit?: number
}

const tableName = "afk-runs"

const rowFromItem = (item: Item): RunHistoryRow | null => {
  const runId = readS(item, "run_id")
  if (!runId) return null
  return {
    runId,
    status: (readS(item, "status") ?? "running") as RunHistoryStatus,
    owner: readS(item, "owner") ?? "",
    repo: readS(item, "repo") ?? "",
    branch: readS(item, "branch") ?? "",
    sha: readS(item, "sha") ?? "",
    image: readS(item, "image") ?? "",
    instanceId: readS(item, "instance_id") ?? "",
    instanceType: readS(item, "instance_type") ?? "",
    spot: readB(item, "spot") ?? false,
    startedAt: readS(item, "started_at") ?? "",
    stoppedAt: readS(item, "stopped_at"),
    exitCode: readN(item, "exit_code"),
    timeoutHours: readN(item, "timeout_hours") ?? 0,
    stopReason: readS(item, "stop_reason"),
  }
}

export class HistoryService extends Context.Tag("HistoryService")<
  HistoryService,
  {
    readonly recordStart: (
      input: RecordStartInput,
    ) => Effect.Effect<void, AwsError | ConfigError | UserError>
    readonly recordStop: (input: {
      readonly runId: string
      readonly status: RunHistoryStatus
      readonly stoppedAt: string
      readonly exitCode?: number
      readonly stopReason?: string
    }) => Effect.Effect<void, AwsError | ConfigError | UserError>
    readonly query: (
      input: QueryInput,
    ) => Effect.Effect<ReadonlyArray<RunHistoryRow>, AwsError | ConfigError | UserError>
  }
>() {}

export const HistoryServiceLive = Layer.effect(
  HistoryService,
  Effect.gen(function* () {
    const ddb = yield* DynamoDb
    const cfg = yield* ConfigService

    const region = cfg.load.pipe(
      Effect.map((r) => r.config.aws?.region ?? DEFAULT_REGION),
    )

    return HistoryService.of({
      recordStart: (input) =>
        Effect.gen(function* () {
          const r = yield* region
          const item: Item = {
            run_id: S(input.runId),
            status: S("running"),
            owner: S(input.owner),
            repo: S(input.repo),
            branch: S(input.branch),
            sha: S(input.sha),
            image: S(input.image),
            instance_id: S(input.instanceId),
            instance_type: S(input.instanceType),
            spot: B(input.spot),
            started_at: S(input.startedAt),
            timeout_hours: N(input.timeoutHours),
          }
          yield* ddb.putItem({ region: r, table: tableName, item })
        }),

      recordStop: ({ runId, status, stoppedAt, exitCode, stopReason }) =>
        Effect.gen(function* () {
          const r = yield* region
          const names: Record<string, string> = { "#s": "status" }
          const values: Record<string, ReturnType<typeof S>> = {
            ":s": S(status),
            ":t": S(stoppedAt),
          }
          let expr = "SET #s = :s, stopped_at = :t"
          if (exitCode !== undefined) {
            names["#e"] = "exit_code"
            values[":e"] = N(exitCode)
            expr += ", #e = :e"
          }
          if (stopReason !== undefined) {
            values[":r"] = S(stopReason)
            expr += ", stop_reason = :r"
          }
          yield* ddb.updateItem({
            region: r,
            table: tableName,
            key: { run_id: S(runId) },
            updateExpression: expr,
            expressionAttributeNames: names,
            expressionAttributeValues: values,
          })
        }),

      query: ({ owner, repo, sinceIsoUtc, limit }) =>
        Effect.gen(function* () {
          const r = yield* region

          // Prefer the by-owner GSI when an owner is set; otherwise by-repo if
          // a repo is set; otherwise fall back to a full scan (acceptable for
          // small tables, which is all we expect during v1).
          if (owner) {
            const values: Record<string, ReturnType<typeof S>> = {
              ":o": S(owner),
            }
            // `owner` is a DynamoDB reserved keyword; alias via #o.
            const names: Record<string, string> = { "#o": "owner" }
            let keyExpr = "#o = :o"
            if (sinceIsoUtc) {
              values[":t"] = S(sinceIsoUtc)
              keyExpr += " AND started_at >= :t"
            }
            const items = yield* ddb.query({
              region: r,
              table: tableName,
              indexName: "by-owner",
              keyConditionExpression: keyExpr,
              expressionAttributeNames: names,
              expressionAttributeValues: values,
              scanIndexForward: false,
              ...(limit !== undefined ? { limit } : {}),
            })
            return items
              .map(rowFromItem)
              .filter((x): x is RunHistoryRow => x !== null)
              .filter((row) => !repo || row.repo === repo)
          }
          if (repo) {
            const values: Record<string, ReturnType<typeof S>> = {
              ":r": S(repo),
            }
            let keyExpr = "repo = :r"
            if (sinceIsoUtc) {
              values[":t"] = S(sinceIsoUtc)
              keyExpr += " AND started_at >= :t"
            }
            const items = yield* ddb.query({
              region: r,
              table: tableName,
              indexName: "by-repo",
              keyConditionExpression: keyExpr,
              expressionAttributeValues: values,
              scanIndexForward: false,
              ...(limit !== undefined ? { limit } : {}),
            })
            return items
              .map(rowFromItem)
              .filter((x): x is RunHistoryRow => x !== null)
          }
          // Full scan path (no owner, no repo).
          const items = yield* ddb.scan({
            region: r,
            table: tableName,
            ...(sinceIsoUtc
              ? {
                  filterExpression: "started_at >= :t",
                  expressionAttributeValues: { ":t": S(sinceIsoUtc) },
                }
              : {}),
            ...(limit !== undefined ? { limit } : {}),
          })
          return items
            .map(rowFromItem)
            .filter((x): x is RunHistoryRow => x !== null)
            .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
        }),
    })
  }),
)

// Re-export so consumers can reuse the table-name constant if needed.
export { tableName as RUNS_TABLE_NAME }
// (suppress unused warning if TABLE_SUFFIX is dead)
void TABLE_SUFFIX
