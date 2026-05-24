import { Command } from "@effect/cli"
import { Effect } from "effect"
import { SecretStore } from "../../services/backend/SecretStore.ts"
import { Output } from "../../infra/Output.ts"

export const ls = Command.make("ls", {}, () =>
  Effect.gen(function* () {
    const secrets = yield* SecretStore
    const out = yield* Output
    const list = yield* secrets.list
    yield* out.emit({
      data: list,
      human: () =>
        out.printTable(list, [
          { header: "NAME", value: (s) => s.name },
          { header: "REFERENCE", value: (s) => s.reference },
          {
            header: "LAST MODIFIED",
            value: (s) => s.lastModified ?? "-",
          },
        ]),
    })
  }),
)
