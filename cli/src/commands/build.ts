import { Command, Options } from "@effect/cli"
import { Effect } from "effect"
import { BuildService } from "../services/BuildService.ts"
import { ConfigService } from "../services/ConfigService.ts"
import { Output } from "../infra/Output.ts"
import { DEFAULT_REGION } from "../constants.ts"

const ref = Options.text("ref").pipe(
  Options.optional,
  Options.withDescription(
    "git ref (branch, sha, or tag); defaults to current branch",
  ),
)

export const build = Command.make("build", { ref }, ({ ref }) =>
  Effect.gen(function* () {
    const builder = yield* BuildService
    const cfg = yield* ConfigService
    const out = yield* Output

    const { config } = yield* cfg.load
    const region = config.aws?.region ?? DEFAULT_REGION

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
