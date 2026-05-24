import { Args, Command } from "@effect/cli"
import { Effect } from "effect"
import { Team } from "../../services/backend/Team.ts"
import { Output } from "../../infra/Output.ts"

const name = Args.text({ name: "name" })

export const rm = Command.make("rm", { name }, ({ name }) =>
  Effect.gen(function* () {
    const team = yield* Team
    const out = yield* Output
    yield* team.rm(name)
    yield* out.emit({
      data: { name, removed: true },
      human: () => out.print(`removed '${name}'`),
    })
  }),
)
