import { Effect, Layer } from "effect"
import {
  DynamoDb,
  N,
  S,
  B,
  readB,
  readN,
  readS,
  type Item,
} from "../../adapters/aws/DynamoDb.ts"
import { ConfigService } from "../../services/ConfigService.ts"
import { RunHistory, type HistoryRow } from "../../services/backend/RunHistory.ts"
import { DEFAULT_REGION } from "../../constants.ts"

const TABLE_NAME = "afk-runs"

const parseSince = (input: string | undefined): string | undefined => {
  if (!input) return undefined
  const m = /^(\d+)\s*([smhd])$/i.exec(input.trim())
  if (!m) return undefined
  const n = Number(m[1])
  const unit = m[2]!.toLowerCase()
  const seconds =
    unit === "s" ? n : unit === "m" ? n * 60 : unit === "h" ? n * 3600 : n * 86400
  return new Date(Date.now() - seconds * 1000).toISOString()
}

const rowFromItem = (item: Item): HistoryRow | null => {
  const runId = readS(item, "run_id")
  if (!runId) return null
  const status = readS(item, "status") ?? "running"
  return {
    runId,
    owner: readS(item, "owner") ?? "",
    repo: readS(item, "repo") ?? "",
    branch: readS(item, "branch") ?? "",
    sha: readS(item, "sha") ?? "",
    image: readS(item, "image") ?? "",
    resourceId: readS(item, "instance_id") ?? "",
    status: status === "running" ? "RUNNING" : "STOPPED",
    startedAt: readS(item, "started_at") ?? "",
    stoppedAt: readS(item, "stopped_at"),
    exitCode: readN(item, "exit_code"),
    timeoutHours: readN(item, "timeout_hours") ?? 0,
    backendDetails: {
      instanceType: readS(item, "instance_type") ?? "",
      spot: String(readB(item, "spot") ?? false),
      ...(readS(item, "stop_reason")
        ? { stopReason: readS(item, "stop_reason")! }
        : {}),
    },
  }
}

/**
 * AWS implementation of RunHistory. Backed by the DynamoDB `afk-runs` table
 * provisioned by Terraform. Indexed by `run_id` (PK), with GSIs on `owner`
 * and `repo` for `afk history` queries.
 */
export const AwsRunHistoryLive = Layer.effect(
  RunHistory,
  Effect.gen(function* () {
    const ddb = yield* DynamoDb
    const cfg = yield* ConfigService

    const region = cfg.load.pipe(
      Effect.map((r) => r.config.aws?.region ?? DEFAULT_REGION),
    )

    return RunHistory.of({
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
            instance_id: S(input.resourceId),
            instance_type: S(input.backendDetails?.instanceType ?? ""),
            spot: B(input.backendDetails?.spot === "true"),
            started_at: S(input.startedAt),
            timeout_hours: N(input.timeoutHours),
          }
          yield* ddb.putItem({ region: r, table: TABLE_NAME, item })
        }),

      recordComplete: ({ runId, stoppedAt, exitCode }) =>
        Effect.gen(function* () {
          const r = yield* region
          const names: Record<string, string> = { "#s": "status" }
          const values: Record<string, ReturnType<typeof S>> = {
            ":s": S(exitCode === 0 ? "stopped" : "failed"),
            ":t": S(stoppedAt),
          }
          let expr = "SET #s = :s, stopped_at = :t"
          if (exitCode !== undefined) {
            names["#e"] = "exit_code"
            values[":e"] = N(exitCode)
            expr += ", #e = :e"
          }
          yield* ddb.updateItem({
            region: r,
            table: TABLE_NAME,
            key: { run_id: S(runId) },
            updateExpression: expr,
            expressionAttributeNames: names,
            expressionAttributeValues: values,
          })
        }),

      query: ({ since, owner, branch, limit }) =>
        Effect.gen(function* () {
          const r = yield* region
          const sinceIsoUtc = parseSince(since)

          if (owner) {
            const values: Record<string, ReturnType<typeof S>> = { ":o": S(owner) }
            const names: Record<string, string> = { "#o": "owner" }
            let keyExpr = "#o = :o"
            if (sinceIsoUtc) {
              values[":t"] = S(sinceIsoUtc)
              keyExpr += " AND started_at >= :t"
            }
            const items = yield* ddb.query({
              region: r,
              table: TABLE_NAME,
              indexName: "by-owner",
              keyConditionExpression: keyExpr,
              expressionAttributeNames: names,
              expressionAttributeValues: values,
              scanIndexForward: false,
              ...(limit !== undefined ? { limit } : {}),
            })
            return items
              .map(rowFromItem)
              .filter((x): x is HistoryRow => x !== null)
              .filter((row) => !branch || row.branch === branch)
          }
          const items = yield* ddb.scan({
            region: r,
            table: TABLE_NAME,
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
            .filter((x): x is HistoryRow => x !== null)
            .filter((row) => !branch || row.branch === branch)
            .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
        }),
    })
  }),
)
