import { Args, Command } from "@effect/cli"
import { Effect } from "effect"
import { RunService } from "../services/RunService.ts"
import { Output } from "../infra/Output.ts"

const runId = Args.text({ name: "run-id" })

export const kill = Command.make("kill", { runId }, ({ runId }) =>
  Effect.gen(function* () {
    const runs = yield* RunService
    const out = yield* Output
    yield* runs.kill(runId)
    yield* out.emit({
      data: { runId, stopped: true },
      human: () => out.print(`stopped ${runId}`),
    })
  }),
)
