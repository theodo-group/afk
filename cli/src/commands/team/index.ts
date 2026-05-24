import { Command } from "@effect/cli"
import { Effect } from "effect"
import { Output } from "../../infra/Output.ts"
import { add } from "./add.ts"
import { ls } from "./ls.ts"
import { rm } from "./rm.ts"

export const team = Command.make("team", {}, () =>
  Effect.gen(function* () {
    const out = yield* Output
    yield* out.print("Use `afk team add|ls|rm`. See `afk team --help`.")
  }),
).pipe(Command.withSubcommands([add, ls, rm]))
