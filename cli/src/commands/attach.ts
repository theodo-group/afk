import { Args, Command } from "@effect/cli"
import { Effect } from "effect"
import { RunService } from "../services/RunService.ts"

const runId = Args.text({ name: "run-id" })

export const attach = Command.make("attach", { runId }, ({ runId }) =>
  Effect.gen(function* () {
    const runs = yield* RunService
    yield* runs.attach(runId)
  }),
)
