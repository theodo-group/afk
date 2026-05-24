import { Args, Command } from "@effect/cli"
import { Effect } from "effect"
import { SecretStore } from "../../services/backend/SecretStore.ts"
import { Output } from "../../infra/Output.ts"

const name = Args.text({ name: "name" })

export const rm = Command.make("rm", { name }, ({ name }) =>
  Effect.gen(function* () {
    const secrets = yield* SecretStore
    const out = yield* Output
    yield* secrets.delete(name)
    yield* out.emit({
      data: { name, deleted: true },
      human: () => out.print(`deleted secret '${name}'`),
    })
  }),
)
