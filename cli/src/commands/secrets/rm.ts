import { Args, Command } from "@effect/cli"
import { Effect } from "effect"
import { SecretStore } from "../../services/backend/SecretStore.ts"
import { Output } from "../../infra/Output.ts"
import { label, personal, scopeOf } from "./scope.ts"

const name = Args.text({ name: "name" })

export const rm = Command.make("rm", { personal, name }, ({ personal, name }) =>
  Effect.gen(function* () {
    const secrets = yield* SecretStore
    const out = yield* Output
    yield* secrets.delete(name, scopeOf(personal))
    yield* out.emit({
      data: { name, scope: scopeOf(personal), deleted: true },
      human: () => out.print(`deleted ${label(personal)} '${name}'`),
    })
  }),
)
