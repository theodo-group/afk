import { Effect, Either, Layer, Schema } from "effect"
import {
  DynamoDb,
  B,
  N,
  S,
  readB,
  readN,
  readS,
  type AttrValue,
  type Item,
} from "../../adapters/aws/DynamoDb.ts"
import { ConfigService } from "../../services/ConfigService.ts"
import {
  ScheduleStore,
  type ReplaceResult,
  type StoredEntry,
} from "../../services/backend/ScheduleStore.ts"
import {
  EntryOutcome,
  EntryState,
  StoredEnv,
  Trigger,
} from "../../schema/Schedule.ts"
import { DEFAULT_REGION, scheduleTableName } from "../../constants.ts"

const decodeTrigger = Schema.decodeUnknownEither(Trigger)
const decodeState = Schema.decodeUnknownEither(EntryState)
const decodeOutcome = Schema.decodeUnknownEither(EntryOutcome)
const decodeEnv = Schema.decodeUnknownEither(StoredEnv)

const parseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
}

/**
 * The environment attribute as an Entry holds it, or null if the row carries
 * one that can no longer be read.
 *
 * **Absent is not a failure.** Every row written before Entries carried an
 * environment lacks the attribute, and `entryFromItem`'s null is dropped
 * *silently* by `listOf` — so treating absent as a decode failure would make
 * the whole pre-existing table vanish from `ls` and from the tick, with no
 * error reported anywhere. Only a present-but-unparseable value costs the row.
 */
const envFromItem = (item: Item): StoredEnv | null => {
  const raw = readS(item, "env")
  if (raw === undefined) return []
  const decoded = decodeEnv(parseJson(raw))
  return Either.isRight(decoded) ? decoded.right : null
}

/**
 * A row back into an Entry, or null if it is not one. The trigger and the
 * environment cross the wire as JSON strings — `AttrValue` carries no map type
 * — so they are the two fields decoded rather than read, and a row whose
 * trigger no longer parses is dropped rather than launched on a guess.
 */
export const entryFromItem = (item: Item): StoredEntry | null => {
  const scheduleId = readS(item, "schedule_id")
  const entryId = readS(item, "entry_id")
  const rawTrigger = readS(item, "trigger")
  if (!scheduleId || !entryId || !rawTrigger) return null

  const parsed = decodeTrigger(parseJson(rawTrigger))
  if (Either.isLeft(parsed)) return null

  const state = decodeState(readS(item, "state") ?? "pending")
  if (Either.isLeft(state)) return null
  const env = envFromItem(item)
  if (env === null) return null
  const outcome = decodeOutcome(readS(item, "outcome"))

  return {
    scheduleId,
    entryId,
    state: state.right,
    trigger: parsed.right,
    ref: readS(item, "ref") ?? "",
    command: readS(item, "command") ?? "",
    image: readS(item, "image") ?? "",
    env,
    owner: readS(item, "owner") ?? "",
    timeoutHours: readN(item, "timeout_hours") ?? 0,
    onDemand: readB(item, "on_demand") ?? false,
    ...(readS(item, "instance_type")
      ? { instanceType: readS(item, "instance_type")! }
      : {}),
    submittedAt: readS(item, "submitted_at") ?? "",
    launchAttempts: readN(item, "launch_attempts") ?? 0,
    ...(readS(item, "last_error")
      ? { lastError: readS(item, "last_error")! }
      : {}),
    ...(readS(item, "not_before")
      ? { notBefore: readS(item, "not_before")! }
      : {}),
    ...(readS(item, "run_id") ? { runId: readS(item, "run_id")! } : {}),
    ...(readS(item, "launched_at")
      ? { launchedAt: readS(item, "launched_at")! }
      : {}),
    ...(readS(item, "settled_at")
      ? { settledAt: readS(item, "settled_at")! }
      : {}),
    ...(Either.isRight(outcome) ? { outcome: outcome.right } : {}),
    ...(readS(item, "reason") ? { reason: readS(item, "reason")! } : {}),
  }
}

export const itemFromEntry = (e: StoredEntry): Item => ({
  schedule_id: S(e.scheduleId),
  entry_id: S(e.entryId),
  state: S(e.state),
  trigger: S(JSON.stringify(e.trigger)),
  ref: S(e.ref),
  command: S(e.command),
  image: S(e.image),
  owner: S(e.owner),
  timeout_hours: N(e.timeoutHours),
  on_demand: B(e.onDemand),
  submitted_at: S(e.submittedAt),
  launch_attempts: N(e.launchAttempts),
  // `.length`, not truthiness: `[]` is truthy, and writing "[]" onto every
  // minimal row would add a key the round-trip test asserts is absent.
  ...(e.env.length > 0 ? { env: S(JSON.stringify(e.env)) } : {}),
  ...(e.lastError ? { last_error: S(e.lastError) } : {}),
  ...(e.instanceType ? { instance_type: S(e.instanceType) } : {}),
  ...(e.notBefore ? { not_before: S(e.notBefore) } : {}),
  ...(e.runId ? { run_id: S(e.runId) } : {}),
  ...(e.launchedAt ? { launched_at: S(e.launchedAt) } : {}),
  ...(e.settledAt ? { settled_at: S(e.settledAt) } : {}),
  ...(e.outcome ? { outcome: S(e.outcome) } : {}),
  ...(e.reason ? { reason: S(e.reason) } : {}),
})

/**
 * AWS implementation of ScheduleStore, on the DynamoDB `<prefix>-schedule`
 * table provisioned by Terraform. `schedule_id` is the partition key and
 * `entry_id` the sort key, so one Schedule's Entries are a single Query.
 */
export const AwsScheduleStoreLive = Layer.effect(
  ScheduleStore,
  Effect.gen(function* () {
    const ddb = yield* DynamoDb
    const cfg = yield* ConfigService

    const region = cfg.load.pipe(
      Effect.map((r) => r.config.aws?.region ?? DEFAULT_REGION),
    )
    const tableName = cfg.load.pipe(
      Effect.map((r) => scheduleTableName(r.config.aws?.resourcePrefix)),
    )

    const listOf = (scheduleId?: string) =>
      Effect.gen(function* () {
        const r = yield* region
        const table = yield* tableName
        const items = scheduleId
          ? yield* ddb.query({
              region: r,
              table,
              keyConditionExpression: "schedule_id = :s",
              expressionAttributeValues: { ":s": S(scheduleId) },
            })
          : yield* ddb.scan({ region: r, table })
        return items
          .map(entryFromItem)
          .filter((e): e is StoredEntry => e !== null)
      })

    const update = (
      scheduleId: string,
      entryId: string,
      updateExpression: string,
      names: Record<string, string>,
      values: Record<string, AttrValue>,
    ) =>
      Effect.gen(function* () {
        const r = yield* region
        const table = yield* tableName
        yield* ddb.updateItem({
          region: r,
          table,
          key: { schedule_id: S(scheduleId), entry_id: S(entryId) },
          updateExpression,
          expressionAttributeNames: names,
          expressionAttributeValues: values,
        })
      })

    return ScheduleStore.of({
      replace: (scheduleId, entries) =>
        Effect.gen(function* () {
          const r = yield* region
          const table = yield* tableName
          const existing = yield* listOf(scheduleId)
          const inFlight = new Set(
            existing
              .filter((e) => e.state === "launched")
              .map((e) => e.entryId),
          )

          const writable = entries.filter((e) => !inFlight.has(e.entryId))
          yield* Effect.all(
            writable.map((e) =>
              ddb.putItem({ region: r, table, item: itemFromEntry(e) }),
            ),
            { concurrency: 8 },
          )

          const incoming = new Set(entries.map((e) => e.entryId))
          const stale = existing.filter(
            (e) => !incoming.has(e.entryId) && !inFlight.has(e.entryId),
          )
          yield* Effect.all(
            stale.map((e) =>
              ddb.deleteItem({
                region: r,
                table,
                key: { schedule_id: S(scheduleId), entry_id: S(e.entryId) },
              }),
            ),
            { concurrency: 8 },
          )

          return {
            written: writable.length,
            preserved: entries
              .filter((e) => inFlight.has(e.entryId))
              .map((e) => e.entryId),
            removed: stale.length,
          } satisfies ReplaceResult
        }),

      list: listOf,

      markLaunched: ({ scheduleId, entryId, runId, launchedAt }) =>
        update(
          scheduleId,
          entryId,
          "SET #st = :st, run_id = :r, launched_at = :l REMOVE settled_at, outcome, reason, last_error",
          { "#st": "state" },
          { ":st": S("launched"), ":r": S(runId), ":l": S(launchedAt) },
        ),

      markSettled: ({ scheduleId, entryId, outcome, reason, settledAt }) =>
        update(
          scheduleId,
          entryId,
          "SET #st = :st, outcome = :o, reason = :why, settled_at = :t",
          { "#st": "state" },
          {
            ":st": S(outcome === "success" ? "done" : "failed"),
            ":o": S(outcome),
            ":why": S(reason),
            ":t": S(settledAt),
          },
        ),

      recordLaunchFailure: ({ scheduleId, entryId, attempts, error }) =>
        update(
          scheduleId,
          entryId,
          "SET launch_attempts = :n, last_error = :e",
          {},
          { ":n": N(attempts), ":e": S(error) },
        ),

      rearm: ({ scheduleId, entryId, notBefore }) =>
        update(
          scheduleId,
          entryId,
          "SET #st = :st, not_before = :n REMOVE run_id, launched_at",
          { "#st": "state" },
          { ":st": S("pending"), ":n": S(notBefore) },
        ),

      cancel: (scheduleId) =>
        Effect.gen(function* () {
          const entries = yield* listOf(scheduleId)
          const withdrawable = entries.filter((e) => e.state === "pending")
          yield* Effect.all(
            withdrawable.map((e) =>
              update(
                scheduleId,
                e.entryId,
                "SET #st = :st",
                { "#st": "state" },
                { ":st": S("cancelled") },
              ),
            ),
            { concurrency: 8 },
          )
          return withdrawable.length
        }),
    })
  }),
)
