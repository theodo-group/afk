import { Args, Command, Options } from "@effect/cli"
import { Effect, Option } from "effect"
import { RunService } from "../services/RunService.ts"
import { LogStore } from "../services/backend/LogStore.ts"
import { ConfigService } from "../services/ConfigService.ts"
import { HistoryService } from "../services/HistoryService.ts"
import { pickRunId } from "./pickRun.ts"
import { DEFAULT_MAIN_SERVICE } from "../constants.ts"
import { UserError } from "../infra/Errors.ts"

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
  Options.withDescription(
    "time window for historical reads (e.g. 1h, 24h, 7d). default 30d",
  ),
)

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
        runId._tag === "Some"
          ? Option.some(runId.value)
          : yield* pickRunId(hist)
      if (Option.isNone(picked)) return

      // findByRunId resolves a leading prefix to the canonical full id when
      // the Run is still live. For a self-terminated cloud Run the live
      // lookup 404s — but the LogStore reads from a persistent source
      // (CloudWatch / Cloud Logging / Worker storage / bind-mounted file)
      // that outlives the VM, and Cloud Logging's filter is exact-match, so
      // a prefix would never match. Fall back to history (which the picker
      // already queries) and resolve the prefix there.
      const resolvedRunId = yield* runs.findByRunId(picked.value).pipe(
        Effect.map((r) => r.runId),
        Effect.catchTag("UserError", () =>
          hist.query({ limit: 100 }).pipe(
            Effect.flatMap((rows) => {
              const exact = rows.find((r) => r.runId === picked.value)
              if (exact) return Effect.succeed(exact.runId)
              const matches = rows.filter((r) =>
                r.runId.startsWith(picked.value),
              )
              if (matches.length === 1) return Effect.succeed(matches[0]!.runId)
              if (matches.length === 0) {
                return Effect.fail(
                  new UserError({
                    message: `Run ${picked.value} not found.`,
                    hint: "Use `afk history` to list past Runs.",
                  }),
                )
              }
              return Effect.fail(
                new UserError({
                  message: `Run id prefix '${picked.value}' is ambiguous (${matches.length} matches).`,
                  hint:
                    "Use a longer prefix. Matches:\n" +
                    matches.map((r) => `  ${r.runId}`).join("\n"),
                }),
              )
            }),
          ),
        ),
      )

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
