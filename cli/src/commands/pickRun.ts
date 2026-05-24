import { Prompt } from "@effect/cli"
import { DateTime, Duration, Effect, Option } from "effect"
import type { Terminal } from "@effect/platform"
import {
  HistoryService,
  type RunHistoryRow,
} from "../services/HistoryService.ts"
import { UserError } from "../infra/Errors.ts"

const choiceTitle = (r: RunHistoryRow): string => {
  const id = r.runId.length > 8 ? `${r.runId.slice(0, 8)}…` : r.runId
  const when = r.startedAt.replace("T", " ").replace(/\..*$/, "")
  return `${id}  ${r.status.padEnd(7)}  ${r.branch}  ${when}`
}

/**
 * No run-id given: let the developer pick from recent Runs instead of copying
 * an id out of `afk history`. Shared by `afk logs` and `afk attach`. Returns
 * None when the picker is cancelled (Ctrl-C), and fails when there is nothing
 * to pick from or stdout is not a terminal (so a pipe errors rather than hangs).
 */
export const pickRunId = (
  hist: typeof HistoryService.Service,
  message = "Select a Run",
): Effect.Effect<Option.Option<string>, UserError, Terminal.Terminal> =>
  Effect.gen(function* () {
    const since = DateTime.subtractDuration(
      yield* DateTime.now,
      Duration.days(30),
    )
    const rows = yield* hist
      .query({ since, limit: 25 })
      .pipe(
        Effect.catchAll((e) =>
          Effect.fail(new UserError({ message: String(e) })),
        ),
      )
    if (rows.length === 0) {
      return yield* Effect.fail(
        new UserError({ message: "No Runs in history to choose from." }),
      )
    }
    if (!process.stdout.isTTY) {
      return yield* Effect.fail(
        new UserError({
          message: "No run-id given and stdout is not a terminal.",
          hint: "Pass a run-id (see `afk history`).",
        }),
      )
    }
    return yield* Prompt.select({
      message,
      choices: rows.map((r) => ({ title: choiceTitle(r), value: r.runId })),
      maxPerPage: 15,
    }).pipe(
      Effect.map(Option.some),
      // Ctrl-C / quit out of the picker is a clean cancel, not an error.
      Effect.catchTag("QuitException", () =>
        Effect.succeed(Option.none<string>()),
      ),
    )
  })
