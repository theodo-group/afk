import { Command } from "@effect/cli"
import { Effect } from "effect"
import { put } from "./put.ts"
import { ls } from "./ls.ts"
import { rm } from "./rm.ts"

export const secrets = Command.make("secrets", {}, () =>
  Effect.sync(() => {
    console.log("Use `afk secrets put|ls|rm`. See `afk secrets --help`.")
  }),
).pipe(Command.withSubcommands([put, ls, rm]))
