import { Command } from "@effect/cli"
import { Effect } from "effect"
import { Output } from "../../infra/Output.ts"
import { put } from "./put.ts"
import { ls } from "./ls.ts"
import { rm } from "./rm.ts"

export const secrets = Command.make("secrets", {}, () =>
  Effect.gen(function* () {
    const out = yield* Output
    yield* out.print("Use `afk secrets put|ls|rm`. See `afk secrets --help`.")
  }),
).pipe(Command.withSubcommands([put, ls, rm]))
