import { Command, Options } from "@effect/cli"
import { Effect } from "effect"
import { BootstrapService } from "../services/BootstrapService.ts"
import { Output } from "../infra/Output.ts"

const region = Options.text("region").pipe(
  Options.withDefault("us-east-1"),
  Options.withDescription(
    "region to bootstrap in (provider=aws|gcp; ignored for cloudflare/local)",
  ),
)

const provider = Options.choice("provider", [
  "aws",
  "cloudflare",
  "local",
  "gcp",
]).pipe(
  Options.withDefault("aws"),
  Options.withDescription(
    "backend to bootstrap (local runs on your own Docker daemon)",
  ),
)

export const init = Command.make(
  "init",
  { region, provider },
  ({ region, provider }) =>
    Effect.gen(function* () {
      const boot = yield* BootstrapService
      const out = yield* Output
      const result = yield* boot.init({
        provider: provider as "aws" | "cloudflare" | "local" | "gcp",
        region,
        projectDir: process.cwd(),
      })
      yield* out.emit({
        data: result,
        human: () => out.print(result.humanReport),
      })
    }),
)
