import { Args, Command } from "@effect/cli"
import { Effect } from "effect"
import { readFileSync } from "node:fs"
import { ScheduleService } from "../../services/ScheduleService.ts"
import type { StoredEnv } from "../../schema/Schedule.ts"
import { renderTrigger } from "../../services/Triggers.ts"
import { Output } from "../../infra/Output.ts"
import { UserError } from "../../infra/Errors.ts"

const file = Args.text({ name: "file" }).pipe(
  Args.optional,
  Args.withDescription(
    "path to the Schedule YAML file, or `-`; omitted, the Schedule is read from stdin",
  ),
)

/**
 * A Schedule need not exist on disk. Nothing reads the file again once the
 * Schedule is submitted, so piping one in is a first-class way to use this —
 * and it keeps a one-off Schedule from having to be parked in a repo that
 * would then refuse the submit for having an untracked file in it.
 */
const readSchedule = (path: string | undefined) =>
  path === undefined || path === "-"
    ? process.stdin.isTTY
      ? Effect.fail(
          new UserError({
            message: "No Schedule given, and stdin is a terminal.",
            hint: "Pass a path, or pipe a Schedule in: `afk schedule submit < nightly.yaml`.",
          }),
        )
      : Effect.try({
          // fd 0 rather than Bun.stdin: synchronous, and the same read path
          // as a file, so there is one failure shape to report.
          try: () => readFileSync(0, "utf8"),
          catch: (cause) =>
            new UserError({
              message: `cannot read a Schedule from stdin: ${String(cause)}`,
            }),
        })
    : Effect.try({
        try: () => readFileSync(path, "utf8"),
        catch: (cause) =>
          new UserError({ message: `cannot read ${path}: ${String(cause)}` }),
      })

const renderEnv = (env: StoredEnv): string => {
  const refs = env.flatMap((e) =>
    e.kind === "secret" ? [`${e.name}→${e.secretName}`] : [],
  )
  const plain = env.flatMap((e) => (e.kind === "plain" ? [e.name] : []))
  return [
    refs.length > 0 ? refs.join(", ") : "no secret references",
    ...(plain.length > 0 ? [`plain: ${plain.join(", ")}`] : []),
  ].join(" | ")
}

export const submit = Command.make("submit", { file }, ({ file }) =>
  Effect.gen(function* () {
    const schedules = yield* ScheduleService
    const out = yield* Output

    const path = file._tag === "Some" ? file.value : undefined
    const content = yield* readSchedule(path)
    const source = path === undefined || path === "-" ? "<stdin>" : path

    const report = yield* schedules.submit({ content, source })

    yield* out.emit({
      data: report,
      human: () =>
        out.print(
          [
            report.imageSkipped
              ? `image already exists: ${report.image}`
              : `pushed: ${report.image}`,
            `submitted ${report.scheduleId} (${report.entries.length} entries)`,
            // The one moment a developer sees what their Schedule will run
            // with. Names on both sides of the arrow, so a mis-paired
            // reference — the right variable holding the wrong credential —
            // is visible rather than discovered at 3am.
            `  env: ${renderEnv(report.env)}`,
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
