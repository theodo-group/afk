import { Args, Command, Options } from "@effect/cli"
import { Effect, Option } from "effect"
import { RunService } from "../services/RunService.ts"
import { HistoryService } from "../services/HistoryService.ts"
import { pickRunId } from "./pickRun.ts"

const runId = Args.text({ name: "run-id" }).pipe(Args.optional)
const service = Options.text("service").pipe(
  Options.optional,
  Options.withDescription(
    "attach to a specific compose service (default: main service)",
  ),
)
const host = Options.boolean("host").pipe(
  Options.withDescription(
    "drop to the VM's host shell instead of `docker exec` into the container",
  ),
)

export const attach = Command.make(
  "attach",
  { runId, service, host },
  ({ runId, service, host }) =>
    Effect.gen(function* () {
      const runs = yield* RunService
      const hist = yield* HistoryService

      // No run-id given: prompt from recent Runs, matching `afk logs`.
      const picked =
        runId._tag === "Some"
          ? Option.some(runId.value)
          : yield* pickRunId(hist, "Select a Run to attach to")
      if (Option.isNone(picked)) return

      yield* runs.attach(picked.value, {
        service: service._tag === "Some" ? service.value : undefined,
        host,
      })
    }),
)
