import { Args, Command } from "@effect/cli"
import { Effect } from "effect"
import { SecretStore } from "../../services/backend/SecretStore.ts"
import { Output } from "../../infra/Output.ts"
import { UserError } from "../../infra/Errors.ts"

const name = Args.text({ name: "name" })
const value = Args.text({ name: "value" }).pipe(Args.optional)

export const put = Command.make("put", { name, value }, ({ name, value }) =>
  Effect.gen(function* () {
    const secrets = yield* SecretStore
    const out = yield* Output

    let plain: string
    if (value._tag === "Some") {
      plain = value.value
    } else {
      const prompt = "Value (input hidden): "
      process.stdout.write(prompt)
      const read = yield* Effect.tryPromise({
        try: async () => {
          for await (const line of console as unknown as AsyncIterable<string>) {
            return line
          }
          return ""
        },
        catch: () =>
          new UserError({ message: "could not read value from stdin" }),
      })
      plain = read.trim()
    }
    if (!plain) {
      return yield* Effect.fail(
        new UserError({ message: "value must not be empty" }),
      )
    }
    yield* secrets.put(name, plain)
    yield* out.emit({
      data: { name, stored: true },
      human: () => out.print(`stored secret '${name}'`),
    })
  }),
)
