import { Context, Effect } from "effect"
import {
  AwsError,
  CloudflareError,
  GcpError,
  ConfigError,
  UserError,
} from "../../infra/Errors.ts"
import type {
  EntryOutcome,
  EntryState,
  Trigger,
} from "../../schema/Schedule.ts"

/**
 * One Entry as the Backend holds it: what the developer authored, plus the
 * image `submit` pinned and everything the tick has learned since.
 */
export interface StoredEntry {
  readonly scheduleId: string
  readonly entryId: string
  readonly state: EntryState
  readonly trigger: Trigger
  readonly ref: string
  readonly command: string
  /** Pinned at submit — the environment the Schedule was tested against. */
  readonly image: string
  readonly owner: string
  readonly timeoutHours: number
  readonly onDemand: boolean
  readonly instanceType?: string
  readonly submittedAt: string
  /** ISO instant a clock Entry becomes eligible; absent on a dependency Entry. */
  readonly notBefore?: string
  readonly runId?: string
  readonly launchedAt?: string
  readonly settledAt?: string
  readonly outcome?: EntryOutcome
  /** Why the Entry settled the way it did, for `afk schedule ls`. */
  readonly reason?: string
}

export interface ReplaceResult {
  readonly written: number
  /** Entry ids left untouched because their Run was already in flight. */
  readonly preserved: ReadonlyArray<string>
  readonly removed: number
}

export interface MarkLaunchedInput {
  readonly scheduleId: string
  readonly entryId: string
  readonly runId: string
  readonly launchedAt: string
}

export interface MarkSettledInput {
  readonly scheduleId: string
  readonly entryId: string
  readonly outcome: EntryOutcome
  readonly reason: string
  readonly settledAt: string
}

export interface RearmInput {
  readonly scheduleId: string
  readonly entryId: string
  readonly notBefore: string
}

type StoreError =
  | AwsError
  | CloudflareError
  | GcpError
  | ConfigError
  | UserError

/**
 * Where submitted Schedules live. One seam so the scheduler and the
 * `afk schedule` commands are written once; only AWS implements it today (see
 * CONTEXT.md "Schedule").
 */
export class ScheduleStore extends Context.Tag("ScheduleStore")<
  ScheduleStore,
  {
    /**
     * Persist a Schedule, replacing whatever the same id held before, so
     * iterating on a Schedule is editing the file and re-running submit.
     *
     * An Entry whose Run is already in flight is never clobbered: its row is
     * left as it stands and reported back in `preserved`. Rows the new file
     * dropped are removed under the same rule.
     */
    readonly replace: (
      scheduleId: string,
      entries: ReadonlyArray<StoredEntry>,
    ) => Effect.Effect<ReplaceResult, StoreError>

    /** Every Entry of one Schedule, or of all of them when no id is given. */
    readonly list: (
      scheduleId?: string,
    ) => Effect.Effect<ReadonlyArray<StoredEntry>, StoreError>

    readonly markLaunched: (
      input: MarkLaunchedInput,
    ) => Effect.Effect<void, StoreError>

    readonly markSettled: (
      input: MarkSettledInput,
    ) => Effect.Effect<void, StoreError>

    /** Put a recurring Entry back to `pending` for its next occurrence. */
    readonly rearm: (input: RearmInput) => Effect.Effect<void, StoreError>

    /**
     * Withdraw a Schedule: every Entry not yet launched becomes `cancelled`.
     * Runs already in flight keep going — the scheduler never kills.
     * Returns how many Entries were withdrawn.
     */
    readonly cancel: (scheduleId: string) => Effect.Effect<number, StoreError>
  }
>() {}
