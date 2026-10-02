import { Context, DateTime, Effect, Layer } from "effect"
import { HistoryService } from "./HistoryService.ts"
import { RunService } from "./RunService.ts"
import { ScheduleStore, type StoredEntry } from "./backend/ScheduleStore.ts"
import { decide, type Decision, type RunFact } from "./Triggers.ts"
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

const EMPTY: TickReport = { launched: [], settled: [], rearmed: [] }

export const SchedulerLive = Layer.effect(
  Scheduler,
  Effect.gen(function* () {
    const store = yield* ScheduleStore
    const history = yield* HistoryService
    const runs = yield* RunService

    const launch = (entry: StoredEntry, at: string) =>
      runs
        .start({
          // One element: the VM joins the argv with spaces and hands the
          // result to `sh -c`, so the developer's own quoting survives intact.
          command: [entry.command],
          ref: entry.ref,
          image: entry.image,
          timeoutHours: entry.timeoutHours,
          backendOverrides: {
            ...(entry.onDemand ? { onDemand: true } : {}),
            ...(entry.instanceType ? { instanceType: entry.instanceType } : {}),
          },
        })
        .pipe(
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
                  scheduleId: entry.scheduleId,
                  entryId: entry.entryId,
                  runId: started.runId,
                }),
              ),
          ),
          // A launch that cannot happen settles the Entry rather than being
          // retried every tick forever — and its dependents learn about it.
          Effect.catchAll((e) =>
            store
              .markSettled({
                scheduleId: entry.scheduleId,
                entryId: entry.entryId,
                outcome: "failure",
                reason: `launch failed: ${e.message}`,
                settledAt: at,
              })
              .pipe(
                Effect.zipRight(
                  Effect.logWarning(
                    `${entry.scheduleId}/${entry.entryId}: launch failed: ${e.message}`,
                  ),
                ),
                Effect.as(undefined),
              ),
          ),
        )

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
        entries: live.map((e) => ({
          scheduleId: e.scheduleId,
          entryId: e.entryId,
          state: e.state,
          trigger: e.trigger,
          timeoutHours: e.timeoutHours,
          ...(e.notBefore !== undefined ? { notBefore: e.notBefore } : {}),
          ...(e.runId !== undefined ? { runId: e.runId } : {}),
          ...(e.launchedAt !== undefined ? { launchedAt: e.launchedAt } : {}),
          ...(e.outcome !== undefined ? { outcome: e.outcome } : {}),
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
      const launched = yield* Effect.all(
        launches.map((e) => launch(e, nowIso)),
        { concurrency: 4 },
      )

      return {
        launched: launched.filter((l) => l !== undefined),
        settled: settled.map((d) => ({
          scheduleId: d.scheduleId,
          entryId: d.entryId,
          outcome: d.outcome,
          reason: d.reason,
        })),
        rearmed: rearms,
      }
    })

    return Scheduler.of({ tick })
  }),
)
