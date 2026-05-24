import { Args, Command } from "@effect/cli"
import { Effect } from "effect"
import { GoldenImageStore } from "../../services/backend/GoldenImage.ts"
import { Output } from "../../infra/Output.ts"

// An AMI id on AWS, a registry tag (or full image URI) on Cloudflare — the
// active Backend's GoldenImageStore knows how to remove its own handle.
const target = Args.text({ name: "id" })

export const goldenRm = Command.make("rm", { id: target }, ({ id }) =>
  Effect.gen(function* () {
    const golden = yield* GoldenImageStore
    const out = yield* Output
    yield* golden.remove(id)
    yield* out.print(`Removed ${id}.`)
  }),
)
