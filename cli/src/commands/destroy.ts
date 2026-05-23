import { Command, Options } from "@effect/cli"
import { Effect } from "effect"
import { BootstrapService } from "../services/BootstrapService.ts"
import { ConfigService } from "../services/ConfigService.ts"
import { Output } from "../infra/Output.ts"
import { DEFAULT_REGION } from "../constants.ts"

const yes = Options.boolean("yes", { aliases: ["y"] }).pipe(
  Options.withDefault(false),
  Options.withDescription(
    "actually delete (without this flag, destroy only prints what it would do)",
  ),
)

export const destroy = Command.make("destroy", { yes }, ({ yes }) =>
  Effect.gen(function* () {
    const boot = yield* BootstrapService
    const cfg = yield* ConfigService
    const out = yield* Output
    const { config, sourceRepoName } = yield* cfg.load
    const provider = config.backend ?? "aws"
    const region = config.aws?.region ?? DEFAULT_REGION

    const result = yield* boot.destroy({
      provider,
      region,
      projectDir: process.cwd(),
      sourceRepoName,
      execute: yes,
    })

    yield* out.emit({
      data: result,
      human: () => out.print(result.humanReport),
    })
  }),
)
