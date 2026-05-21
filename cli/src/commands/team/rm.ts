import { Args, Command } from "@effect/cli"
import { Effect } from "effect"
import { TeamService } from "../../services/TeamService.ts"
import { Output } from "../../infra/Output.ts"

const name = Args.text({ name: "name" })

export const rm = Command.make("rm", { name }, ({ name }) =>
  Effect.gen(function* () {
    const team = yield* TeamService
    const out = yield* Output
    yield* team.rm(name)
    yield* out.emit({
      data: { name, removed: true },
      human: () => out.print(`removed '${name}'`),
    })
  }),
)
