import { Command, Options } from "@effect/cli"
import { Effect } from "effect"
import { BuildService } from "../services/BuildService.ts"
import { Output } from "../infra/Output.ts"

const region = Options.text("region").pipe(Options.withDefault("us-east-1"))
const ref = Options.text("ref").pipe(
  Options.optional,
  Options.withDescription("git ref (branch, sha, or tag); defaults to current branch"),
)

export const build = Command.make("build", { region, ref }, ({ region, ref }) =>
  Effect.gen(function* () {
    const builder = yield* BuildService
    const out = yield* Output
    const result = yield* builder.build({
      region,
      ref: ref._tag === "Some" ? ref.value : undefined,
    })
    yield* out.emit({
      data: result,
      human: () =>
        out.print(
          result.skipped
            ? `image already exists: ${result.image}`
            : `pushed: ${result.image}`,
        ),
    })
  }),
)
