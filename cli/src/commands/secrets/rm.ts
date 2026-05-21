import { Args, Command } from "@effect/cli"
import { Effect } from "effect"
import { SecretService } from "../../services/SecretService.ts"
import { Output } from "../../infra/Output.ts"

const name = Args.text({ name: "name" })

export const rm = Command.make("rm", { name }, ({ name }) =>
  Effect.gen(function* () {
    const secrets = yield* SecretService
    const out = yield* Output
    yield* secrets.rm(name)
    yield* out.emit({
      data: { name, deleted: true },
      human: () => out.print(`deleted secret '${name}'`),
    })
  }),
)
