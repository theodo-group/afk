import { Command } from "@effect/cli"
import { Effect } from "effect"
import { goldenBuild } from "./build.ts"
import { goldenLs } from "./ls.ts"
import { goldenRm } from "./rm.ts"

export const golden = Command.make("golden", {}, () =>
  Effect.sync(() => {
    console.log("Run `afk golden --help` for available subcommands.")
  }),
).pipe(Command.withSubcommands([goldenBuild, goldenLs, goldenRm]))
