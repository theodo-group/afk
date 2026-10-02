import { Command } from "@effect/cli"
import { Effect } from "effect"
import { Output } from "../../infra/Output.ts"
import { submit } from "./submit.ts"
import { ls } from "./ls.ts"
import { cancel } from "./cancel.ts"
import { tick } from "./tick.ts"

export const schedule = Command.make("schedule", {}, () =>
  Effect.gen(function* () {
    const out = yield* Output
    yield* out.print(
      "Use `afk schedule submit|ls|cancel|tick`. See `afk schedule --help`.",
    )
  }),
).pipe(Command.withSubcommands([submit, ls, cancel, tick]))
