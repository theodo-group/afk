import { Args, Command } from "@effect/cli"
import { Effect } from "effect"
import { ScheduleService } from "../../services/ScheduleService.ts"
import { renderTrigger } from "../../services/Triggers.ts"
import { Output } from "../../infra/Output.ts"

const schedule = Args.text({ name: "schedule" }).pipe(
  Args.optional,
  Args.withDescription("a Schedule id; omit to list every Schedule"),
)

export const ls = Command.make("ls", { schedule }, ({ schedule }) =>
  Effect.gen(function* () {
    const schedules = yield* ScheduleService
    const out = yield* Output

    const entries = yield* schedules.list(
      schedule._tag === "Some" ? schedule.value : undefined,
    )
    const sorted = [...entries].sort((a, b) =>
      a.scheduleId === b.scheduleId
        ? a.entryId.localeCompare(b.entryId)
        : a.scheduleId.localeCompare(b.scheduleId),
    )

    yield* out.emit({
      data: sorted,
      human: () =>
        sorted.length === 0
          ? out.print("(no Schedules submitted)")
          : out.printTable(sorted, [
              { header: "SCHEDULE", value: (e) => e.scheduleId },
              { header: "ENTRY", value: (e) => e.entryId },
              { header: "STATE", value: (e) => e.state },
              { header: "TRIGGER", value: (e) => renderTrigger(e.trigger) },
              { header: "REF", value: (e) => e.ref },
              { header: "NEXT", value: (e) => e.notBefore ?? "-" },
              { header: "RUN", value: (e) => e.runId ?? "-" },
              { header: "WHY", value: (e) => e.reason ?? "-" },
            ]),
    })
  }),
)
