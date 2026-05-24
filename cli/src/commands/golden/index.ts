import { Command } from "@effect/cli"
import { Effect } from "effect"
import { Output } from "../../infra/Output.ts"
import { goldenBuild } from "./build.ts"
import { goldenLs } from "./ls.ts"
import { goldenRm } from "./rm.ts"

export const golden = Command.make("golden", {}, () =>
  Effect.gen(function* () {
    const out = yield* Output
    yield* out.print("Run `afk golden --help` for available subcommands.")
  }),
).pipe(Command.withSubcommands([goldenBuild, goldenLs, goldenRm]))
