import { Command } from "@effect/cli"
import { Effect } from "effect"
import { Scheduler } from "../../services/Scheduler.ts"
import { Output } from "../../infra/Output.ts"

/**
 * Run one scheduler pass by hand. The deployed Lambda does exactly this on
 * its tick; having it on the CLI is what makes a Schedule testable end to end
 * before any infrastructure exists.
 */
export const tick = Command.make("tick", {}, () =>
  Effect.gen(function* () {
    const scheduler = yield* Scheduler
    const out = yield* Output

    const report = yield* scheduler.tick
    yield* out.emit({
      data: report,
      human: () =>
        out.print(
          [
            ...report.settled.map(
              (s) =>
                `settled  ${s.scheduleId}/${s.entryId} ${s.outcome} — ${s.reason}`,
            ),
            ...report.rearmed.map(
              (r) => `re-armed ${r.scheduleId}/${r.entryId} → ${r.notBefore}`,
            ),
            ...report.launched.map(
              (l) => `launched ${l.scheduleId}/${l.entryId} as ${l.runId}`,
            ),
            ...report.retrying.map(
              (r) =>
                `retrying ${r.scheduleId}/${r.entryId} — attempt ${r.attempts} refused: ${r.error}`,
            ),
          ].join("\n") || "(nothing due)",
        ),
    })
  }),
)
