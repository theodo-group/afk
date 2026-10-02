import { Args, Command } from "@effect/cli"
import { Effect } from "effect"
import { ScheduleService } from "../../services/ScheduleService.ts"
import { Output } from "../../infra/Output.ts"

const schedule = Args.text({ name: "schedule" }).pipe(
  Args.withDescription("the Schedule id to withdraw"),
)

export const cancel = Command.make("cancel", { schedule }, ({ schedule }) =>
  Effect.gen(function* () {
    const schedules = yield* ScheduleService
    const out = yield* Output

    const withdrawn = yield* schedules.cancel(schedule)
    yield* out.emit({
      data: { schedule, withdrawn },
      human: () =>
        out.print(
          [
            `cancelled ${withdrawn} pending entries of ${schedule}`,
            `Runs already launched keep going — stop one with \`afk kill <run-id>\`.`,
          ].join("\n"),
        ),
    })
  }),
)
