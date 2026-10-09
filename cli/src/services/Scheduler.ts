import { Context, DateTime, Effect, Layer } from "effect"
import { HistoryService } from "./HistoryService.ts"
import { RunService, type RunStarted } from "./RunService.ts"
import { ScheduleStore, type StoredEntry } from "./backend/ScheduleStore.ts"
import { SecretStore } from "./backend/SecretStore.ts"
import { decide, type Decision, type RunFact } from "./Triggers.ts"
import { launchFailureAction, launchFailureDetail } from "./LaunchAttempt.ts"
import { missingRefs } from "./ScheduleEnv.ts"
import { parseSince } from "./SinceWindow.ts"
import {
  AwsError,
  CloudflareError,
  ConfigError,
  DockerError,
  GcpError,
  GitError,
  UserError,
} from "../infra/Errors.ts"
import type { EntryOutcome } from "../schema/Schedule.ts"
import {
  SCHEDULER_GRACE_MINUTES,
  SCHEDULER_LAUNCH_ATTEMPTS,
  SCHEDULER_HISTORY_WINDOW,
  SCHEDULER_STALE_MINUTES,
} from "../constants.ts"

export interface TickReport {
  readonly launched: ReadonlyArray<{
    readonly scheduleId: string
    readonly entryId: string
    readonly runId: string
  }>
  readonly settled: ReadonlyArray<{
    readonly scheduleId: string
    readonly entryId: string
    readonly outcome: EntryOutcome
    readonly reason: string
  }>
  readonly rearmed: ReadonlyArray<{
    readonly scheduleId: string
    readonly entryId: string
    readonly notBefore: string
  }>
  /** Entries whose launch was refused and that stay pending for another tick. */
  readonly retrying: ReadonlyArray<{
    readonly scheduleId: string
    readonly entryId: string
    readonly attempts: number
    readonly error: string
  }>
}

type TickError =
  | UserError
  | AwsError
  | CloudflareError
  | GcpError
  | DockerError
  | GitError
  | ConfigError

/**
 * One pass of the scheduler: read every live Entry, read the Run history,
 * decide, then perform. The deciding is `Triggers.decide` — pure, injected
 * with the clock — so this layer only loads, writes and launches.
 *
 * Idempotent by construction. A tick that crashes half-way leaves the Entries
 * it already moved in their new state and reconsiders the rest next time;
 * nothing here depends on having seen the previous tick.
 */
export class Scheduler extends Context.Tag("Scheduler")<
  Scheduler,
  { readonly tick: Effect.Effect<TickReport, TickError> }
>() {}

/**
 * What one attempted launch came to. Named so the two failure branches widen
 * to a single Effect type rather than TypeScript picking the first.
 */
type LaunchOutcome =
  | {
      readonly kind: "launched"
      readonly scheduleId: string
      readonly entryId: string
      readonly runId: string
    }
  | {
      readonly kind: "retrying"
      readonly scheduleId: string
      readonly entryId: string
      readonly attempts: number
      readonly error: string
    }
  | {
      readonly kind: "gave-up"
      readonly scheduleId: string
      readonly entryId: string
      readonly reason: string
    }

const EMPTY: TickReport = {
  launched: [],
  settled: [],
  rearmed: [],
  retrying: [],
}

export const SchedulerLive = Layer.effect(
  Scheduler,
  Effect.gen(function* () {
    const store = yield* ScheduleStore
    const history = yield* HistoryService
    const runs = yield* RunService
    const secrets = yield* SecretStore

    const launch = (
      entry: StoredEntry,
      at: string,
      storedSecretNames: ReadonlyArray<string>,
    ) => {
      // Checked again here, not only at submit: a secret deleted since then
      // would otherwise cost a whole Run. `UserData` runs `set -uo pipefail`
      // with no `-e`, so a failed SSM fetch writes `NAME=` and the agent works
      // for hours with an empty credential — a refused launch is the cheap
      // outcome. A UserError also settles on the first attempt rather than
      // spending the retry budget, since nothing will fix it by the next tick.
      const missing = missingRefs(
        entry.env.flatMap((e) => (e.kind === "secret" ? [e.secretName] : [])),
        storedSecretNames,
      )
      const attempt: Effect.Effect<RunStarted, TickError> =
        missing.length > 0
          ? Effect.fail(
              new UserError({
                message:
                  missing.length === 1
                    ? `secret '${missing[0]}' is referenced by this Entry but no longer exists`
                    : `secrets ${missing.map((m) => `'${m}'`).join(", ")} are referenced by this Entry but no longer exist`,
                hint: `Restore with \`afk secrets put <name>\`, then re-submit '${entry.scheduleId}'.`,
              }),
            )
          : runs.start({
              // One element: the VM joins the argv with spaces and hands the
              // result to `sh -c`, so the developer's quoting survives intact.
              command: [entry.command],
              ref: entry.ref,
              image: entry.image,
              // The Lambda is the Owner — it makes the call — but the Run is
              // the submitter's, and that is what people should see.
              submittedBy: entry.owner,
              pinned: {
                envEntries: entry.env,
                composeContent: entry.composeContent,
              },
              timeoutHours: entry.timeoutHours,
              backendOverrides: {
                ...(entry.onDemand ? { onDemand: true } : {}),
                ...(entry.instanceType
                  ? { instanceType: entry.instanceType }
                  : {}),
              },
            })
      return attempt.pipe(
        Effect.flatMap((started) =>
          store
            .markLaunched({
              scheduleId: entry.scheduleId,
              entryId: entry.entryId,
              runId: started.runId,
              launchedAt: at,
            })
            .pipe(
              Effect.as({
                kind: "launched" as const,
                scheduleId: entry.scheduleId,
                entryId: entry.entryId,
                runId: started.runId,
              }),
            ),
        ),
        // A refused launch created no Run, so retrying it costs nothing and
        // a Spot capacity blip must not end the Entry. `launchFailureAction`
        // owns that call; the budget is what keeps an unlaunchable Entry
        // from retrying on every tick forever.
        Effect.catchAll((e): Effect.Effect<LaunchOutcome, TickError> => {
          const attempts = entry.launchAttempts + 1
          const detail = launchFailureDetail(e)
          const settledReason =
            attempts === 1
              ? `launch refused: ${detail}`
              : `launch failed after ${attempts} attempts: ${detail}`
          const where = `${entry.scheduleId}/${entry.entryId}`
          const note = Effect.logWarning(
            `${where}: launch attempt ${attempts} failed: ${e.message}`,
          )
          return launchFailureAction(e, attempts, SCHEDULER_LAUNCH_ATTEMPTS) ===
            "retry"
            ? store
                .recordLaunchFailure({
                  scheduleId: entry.scheduleId,
                  entryId: entry.entryId,
                  attempts,
                  error: detail,
                })
                .pipe(
                  Effect.zipRight(note),
                  Effect.as({
                    kind: "retrying" as const,
                    scheduleId: entry.scheduleId,
                    entryId: entry.entryId,
                    attempts,
                    error: detail,
                  }),
                )
            : store
                .markSettled({
                  scheduleId: entry.scheduleId,
                  entryId: entry.entryId,
                  outcome: "failure",
                  reason: settledReason,
                  settledAt: at,
                })
                .pipe(
                  Effect.zipRight(note),
                  Effect.as({
                    kind: "gave-up" as const,
                    scheduleId: entry.scheduleId,
                    entryId: entry.entryId,
                    reason: settledReason,
                  }),
                )
        }),
      )
    }

    const tick = Effect.gen(function* () {
      const all = yield* store.list()
      const live = all.filter(
        (e) => e.state === "pending" || e.state === "launched",
      )
      if (live.length === 0) return EMPTY

      const window = yield* parseSince(SCHEDULER_HISTORY_WINDOW)
      const since = DateTime.subtractDuration(yield* DateTime.now, window)
      const rows = yield* history.query({ since })
      const facts: ReadonlyArray<RunFact> = rows.map((r) => ({
        runId: r.runId,
        running: r.status === "running",
        ...(r.exitCode !== undefined ? { exitCode: r.exitCode } : {}),
      }))

      const now = new Date()
      const decisions = decide({
        nowMs: now.getTime(),
        // Every Entry, not just the live ones: a dependency that settled on an
        // earlier tick is `done`/`failed` by now, and `decide` reads its
        // outcome from exactly those rows. Fed only the live set, a dependent
        // could launch solely on the tick its dependency settled — so a tick
        // that died in between, or a refused launch left for a retry, would
        // leave it pending forever.
        entries: all.map((e) => ({
          scheduleId: e.scheduleId,
          entryId: e.entryId,
          state: e.state,
          trigger: e.trigger,
          timeoutHours: e.timeoutHours,
          ...(e.notBefore !== undefined ? { notBefore: e.notBefore } : {}),
          ...(e.runId !== undefined ? { runId: e.runId } : {}),
          ...(e.launchedAt !== undefined ? { launchedAt: e.launchedAt } : {}),
          ...(e.outcome !== undefined ? { outcome: e.outcome } : {}),
          ...(e.withdrawnAt !== undefined ? { withdrawn: true } : {}),
        })),
        runs: facts,
        staleAfterMinutes: SCHEDULER_STALE_MINUTES,
        graceMinutes: SCHEDULER_GRACE_MINUTES,
      })

      const nowIso = now.toISOString()
      const of = <K extends Decision["kind"]>(kind: K) =>
        decisions.filter(
          (d): d is Extract<Decision, { kind: K }> => d.kind === kind,
        )

      // Settle before re-arming: a recurring Entry records the occurrence that
      // just ended, then goes back to pending for the next one.
      const settled = of("settle")
      yield* Effect.all(
        settled.map((d) =>
          store.markSettled({
            scheduleId: d.scheduleId,
            entryId: d.entryId,
            outcome: d.outcome,
            reason: d.reason,
            settledAt: nowIso,
          }),
        ),
        { concurrency: 8 },
      )

      const rearms = of("rearm").map((d) => ({
        scheduleId: d.scheduleId,
        entryId: d.entryId,
        notBefore: new Date(d.notBeforeMs).toISOString(),
      }))
      yield* Effect.all(rearms.map(store.rearm), { concurrency: 8 })

      const byKey = new Map(
        live.map((e) => [`${e.scheduleId}\u0000${e.entryId}`, e]),
      )
      const launches = of("launch").flatMap((d) => {
        const entry = byKey.get(`${d.scheduleId}\u0000${d.entryId}`)
        return entry ? [entry] : []
      })
      // One list for the whole tick, and only when something is actually due:
      // the preflight is per Entry but the round trip need not be.
      const storedSecretNames =
        launches.length > 0 ? (yield* secrets.list).map((s) => s.name) : []
      const outcomes = yield* Effect.all(
        launches.map((e) => launch(e, nowIso, storedSecretNames)),
        { concurrency: 4 },
      )

      return {
        launched: outcomes.flatMap((o) => (o.kind === "launched" ? [o] : [])),
        retrying: outcomes.flatMap((o) => (o.kind === "retrying" ? [o] : [])),
        // An Entry whose launch was given up on settled this tick too; leaving
        // it out made a tick that failed an Entry print "(nothing due)".
        settled: [
          ...settled.map((d) => ({
            scheduleId: d.scheduleId,
            entryId: d.entryId,
            outcome: d.outcome,
            reason: d.reason,
          })),
          ...outcomes.flatMap((o) =>
            o.kind === "gave-up"
              ? [
                  {
                    scheduleId: o.scheduleId,
                    entryId: o.entryId,
                    outcome: "failure" as const,
                    reason: o.reason,
                  },
                ]
              : [],
          ),
        ],
        rearmed: rearms,
      }
    })

    return Scheduler.of({ tick })
  }),
)
