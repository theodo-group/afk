import { Args, Command, Options, Prompt } from "@effect/cli"
import { DateTime, Duration, Effect, Option } from "effect"
import type { Terminal } from "@effect/platform"
import { RunService } from "../services/RunService.ts"
import { LogStore } from "../services/backend/LogStore.ts"
import { ConfigService } from "../services/ConfigService.ts"
import { HistoryService, type RunHistoryRow } from "../services/HistoryService.ts"
import { UserError } from "../infra/Errors.ts"
import { DEFAULT_MAIN_SERVICE } from "../constants.ts"

const runId = Args.text({ name: "run-id" }).pipe(Args.optional)
const follow = Options.boolean("follow", { aliases: ["f"] })
const service = Options.text("service").pipe(
  Options.optional,
  Options.withDescription("show one named service instead of the main service"),
)
const all = Options.boolean("all").pipe(
  Options.withDescription("show every service, not just the main service"),
)
const since = Options.text("since").pipe(
  Options.withDefault("30d"),
  Options.withDescription("time window for historical reads (e.g. 1h, 24h, 7d). default 30d"),
)

const choiceTitle = (r: RunHistoryRow): string => {
  const id = r.runId.length > 8 ? `${r.runId.slice(0, 8)}…` : r.runId
  const when = r.startedAt.replace("T", " ").replace(/\..*$/, "")
  return `${id}  ${r.status.padEnd(7)}  ${r.branch}  ${when}`
}

/** No run-id given: let the developer pick from recent Runs instead of copying
 * an id out of `afk history`. Returns None when the picker is cancelled. */
const pickRunId = (
  hist: typeof HistoryService.Service,
): Effect.Effect<Option.Option<string>, UserError, Terminal.Terminal> =>
  Effect.gen(function* () {
    const since = DateTime.subtractDuration(yield* DateTime.now, Duration.days(30))
    const rows = yield* hist
      .query({ since, limit: 25 })
      .pipe(Effect.catchAll((e) => Effect.fail(new UserError({ message: String(e) }))))
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
      message: "Select a Run",
      choices: rows.map((r) => ({ title: choiceTitle(r), value: r.runId })),
      maxPerPage: 15,
    }).pipe(
      Effect.map(Option.some),
      // Ctrl-C / quit out of the picker is a clean cancel, not an error.
      Effect.catchTag("QuitException", () => Effect.succeed(Option.none<string>())),
    )
  })

export const logs = Command.make(
  "logs",
  { runId, follow, service, all, since },
  ({ runId, follow, service, all, since }) =>
    Effect.gen(function* () {
      const runs = yield* RunService
      // LogStore is the active backend's tailer, not a fixed provider adapter.
      const logStore = yield* LogStore
      const cfg = yield* ConfigService
      const hist = yield* HistoryService

      const picked =
        runId._tag === "Some" ? Option.some(runId.value) : yield* pickRunId(hist)
      if (Option.isNone(picked)) return
      const resolvedRunId = picked.value

      yield* runs.findByRunId(resolvedRunId)

      const { config, sourceRepoName } = yield* cfg.load

      // Scope is resolved here, not in the backends: default to the main
      // service, --service narrows to one, --all widens to every service (no
      // filter). LogStore only knows "this service, or none = all".
      const mainService = config.mainService ?? DEFAULT_MAIN_SERVICE
      const serviceFilter = all
        ? undefined
        : service._tag === "Some"
          ? service.value
          : mainService

      yield* logStore.tail({
        runId: resolvedRunId,
        repoName: sourceRepoName,
        ...(serviceFilter !== undefined ? { serviceFilter } : {}),
        follow,
        since,
      })
    }),
)
