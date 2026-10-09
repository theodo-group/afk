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
  StoredEnv,
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
  /**
   * The submitter's `.afk.env`, pinned at submit so the Run authenticates as
   * whoever scheduled it. Secret *references*: the Run's own VM dereferences
   * them, and the Scheduler never holds a credential (see CONTEXT.md "Entry").
   */
  readonly env: StoredEnv
  /**
   * The submitter's `afk.compose.yml`, pinned at submit for the same reason as
   * `env`: the Scheduler has no checkout, so without it a scheduled Run would
   * launch with no stack at all. Absent when the project has no compose file.
   */
  readonly composeContent?: string
  readonly owner: string
  readonly timeoutHours: number
  readonly onDemand: boolean
  readonly instanceType?: string
  readonly submittedAt: string
  /**
   * Launches attempted for this Entry so far. A refused launch leaves the
   * Entry `pending` and bumps this; the Scheduler gives up once it reaches
   * SCHEDULER_LAUNCH_ATTEMPTS. Reset by re-submitting.
   */
  readonly launchAttempts: number
  /** Short form of the last launch refusal, while the Entry is still pending. */
  readonly lastError?: string
  /** ISO instant a clock Entry becomes eligible; absent on a dependency Entry. */
  readonly notBefore?: string
  readonly runId?: string
  readonly launchedAt?: string
  readonly settledAt?: string
  readonly outcome?: EntryOutcome
  /** Why the Entry settled the way it did, for `afk schedule ls`. */
  readonly reason?: string
  /**
   * When the Schedule was cancelled while this Entry's Run was in flight. The
   * Run is left to finish — the Scheduler never kills — but a recurring Entry
   * must not re-arm once it does, or the cancel is silently undone.
   */
  readonly withdrawnAt?: string
}

export interface CancelResult {
  /** Entries that had not launched, now `cancelled`. */
  readonly withdrawn: number
  /** Entries whose Run is still going: it finishes, and nothing follows it. */
  readonly inFlight: ReadonlyArray<string>
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

export interface RecordLaunchFailureInput {
  readonly scheduleId: string
  readonly entryId: string
  readonly attempts: number
  readonly error: string
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

    /**
     * A launch was refused and is worth another try: leave the Entry `pending`
     * so the next tick reconsiders it, and remember how many attempts it has
     * cost and why the last one failed.
     */
    readonly recordLaunchFailure: (
      input: RecordLaunchFailureInput,
    ) => Effect.Effect<void, StoreError>

    /** Put a recurring Entry back to `pending` for its next occurrence. */
    readonly rearm: (input: RearmInput) => Effect.Effect<void, StoreError>

    /**
     * Withdraw a Schedule: every Entry not yet launched becomes `cancelled`.
     * Runs already in flight keep going — the scheduler never kills — but
     * their Entries are marked so a recurring one does not come back.
     */
    readonly cancel: (
      scheduleId: string,
      at: string,
    ) => Effect.Effect<CancelResult, StoreError>
  }
>() {}
