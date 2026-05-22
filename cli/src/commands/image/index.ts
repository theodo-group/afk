import { Command } from "@effect/cli"
import { Effect } from "effect"
import { imageBuild } from "./build.ts"
import { imageLs } from "./ls.ts"
import { imageRm } from "./rm.ts"

export const image = Command.make("image", {}, () =>
  Effect.sync(() => {
    console.log("Run `afk image --help` for available subcommands.")
  }),
).pipe(Command.withSubcommands([imageBuild, imageLs, imageRm]))
