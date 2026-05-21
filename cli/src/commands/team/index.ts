import { Command } from "@effect/cli"
import { Effect } from "effect"
import { add } from "./add.ts"
import { ls } from "./ls.ts"
import { rm } from "./rm.ts"

export const team = Command.make("team", {}, () =>
  Effect.sync(() => {
    console.log("Use `afk team add|ls|rm`. See `afk team --help`.")
  }),
).pipe(Command.withSubcommands([add, ls, rm]))
