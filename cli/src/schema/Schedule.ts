import { Schema } from "effect"
import { EnvEntry } from "./Config.ts"

export const ScheduleId = Schema.String.pipe(Schema.brand("ScheduleId"))
export type ScheduleId = typeof ScheduleId.Type

export const EntryId = Schema.String.pipe(Schema.brand("EntryId"))
export type EntryId = typeof EntryId.Type

/**
 * A Trigger exactly as the developer writes it in the Schedule file. The three
 * kinds are distinguished by which key is present; `after` carries two of them,
 * resolved by shape — a duration literal (`2h`) is a clock Trigger, anything
 * else names another Entry. `Triggers.parseTrigger` is what draws that line,
 * and the submit gate refuses an Entry id shaped like a duration so the two can
 * never collide.
 */
export const Trigger = Schema.Union(
  Schema.Struct({ at: Schema.String }),
  Schema.Struct({ cron: Schema.String }),
  Schema.Struct({
    after: Schema.String,
    require: Schema.optional(Schema.Literal("success")),
  }),
)
export type Trigger = typeof Trigger.Type

/**
 * One Entry as authored. The file speaks snake_case (it sits beside the
 * project's other YAML); the decoded value speaks the house camelCase.
 *
 * No `image` field: the author never picks one. `afk schedule submit` builds
 * the environment once and pins it on every Entry — see CONTEXT.md "Entry".
 */
export const ScheduleEntryFile = Schema.Struct({
  id: EntryId,
  ref: Schema.String,
  command: Schema.String,
  trigger: Trigger,
  timeoutHours: Schema.optional(Schema.Number).pipe(
    Schema.fromKey("timeout_hours"),
  ),
  onDemand: Schema.optional(Schema.Boolean).pipe(Schema.fromKey("on_demand")),
  instanceType: Schema.optional(Schema.String).pipe(
    Schema.fromKey("instance_type"),
  ),
})
export type ScheduleEntryFile = typeof ScheduleEntryFile.Type

export const ScheduleFile = Schema.Struct({
  schedule: ScheduleId,
  entries: Schema.Array(ScheduleEntryFile).pipe(Schema.minItems(1)),
})
export type ScheduleFile = typeof ScheduleFile.Type

/**
 * Where an Entry stands. `pending` until its Trigger fires, `launched` while
 * its Run is alive, then `done`/`failed` from that Run's exit code, or
 * `cancelled` if the Schedule was withdrawn first. A `cron` Entry returns to
 * `pending` after each occurrence settles (see CONTEXT.md "Entry").
 */
export const EntryState = Schema.Literal(
  "pending",
  "launched",
  "done",
  "failed",
  "cancelled",
)
export type EntryState = typeof EntryState.Type

export const EntryOutcome = Schema.Literal("success", "failure")
export type EntryOutcome = typeof EntryOutcome.Type

/**
 * The environment an [[entry|Entry]] carries, pinned at submit from the
 * submitter's `.afk.env` so a scheduled [[run|Run]] authenticates as whoever
 * scheduled it rather than as whoever deployed the [[scheduler|Scheduler]].
 *
 * References, not values — `ScheduleEnv.PLAIN_ALLOWED` names the sole literal
 * a Schedule may hold, and submit refuses every other plain entry.
 */
export const StoredEnv = Schema.Array(EnvEntry)
export type StoredEnv = typeof StoredEnv.Type
