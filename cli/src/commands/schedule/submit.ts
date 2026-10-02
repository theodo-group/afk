import { Args, Command } from "@effect/cli"
import { Effect } from "effect"
import { readFileSync } from "node:fs"
import { ScheduleService } from "../../services/ScheduleService.ts"
import { renderTrigger } from "../../services/Triggers.ts"
import { Output } from "../../infra/Output.ts"
import { UserError } from "../../infra/Errors.ts"

const file = Args.text({ name: "file" }).pipe(
  Args.withDescription("path to the Schedule YAML file"),
)

export const submit = Command.make("submit", { file }, ({ file }) =>
  Effect.gen(function* () {
    const schedules = yield* ScheduleService
    const out = yield* Output

    const content = yield* Effect.try({
      try: () => readFileSync(file, "utf8"),
      catch: (cause) =>
        new UserError({ message: `cannot read ${file}: ${String(cause)}` }),
    })

    const report = yield* schedules.submit({ content, source: file })

    yield* out.emit({
      data: report,
      human: () =>
        out.print(
          [
            report.imageSkipped
              ? `image already exists: ${report.image}`
              : `pushed: ${report.image}`,
            `submitted ${report.scheduleId} (${report.entries.length} entries)`,
            ...report.entries.map(
              (e) =>
                `  ${e.entryId.padEnd(24)} ${renderTrigger(e.trigger)}${
                  e.notBefore ? ` → next ${e.notBefore}` : ""
                }`,
            ),
            ...(report.preserved.length > 0
              ? [
                  `  kept in flight (not replaced): ${report.preserved.join(", ")}`,
                ]
              : []),
            ...(report.removed > 0
              ? [`  removed ${report.removed} entries no longer in the file`]
              : []),
          ].join("\n"),
        ),
    })
  }),
)
