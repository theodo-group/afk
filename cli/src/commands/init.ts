import { Command, Options } from "@effect/cli"
import { Effect } from "effect"
import { BootstrapService } from "../services/BootstrapService.ts"
import { Output } from "../infra/Output.ts"

const region = Options.text("region").pipe(
  Options.withDefault("us-east-1"),
  Options.withDescription("AWS region to bootstrap in"),
)

const provider = Options.choice("provider", ["aws"]).pipe(
  Options.withDefault("aws"),
  Options.withDescription("cloud backend (only 'aws' is supported in v1)"),
)

export const init = Command.make("init", { region, provider }, ({ region }) =>
  Effect.gen(function* () {
    const boot = yield* BootstrapService
    const out = yield* Output
    const result = yield* boot.init({ region, projectDir: process.cwd() })
    yield* out.emit({
      data: result,
      human: () =>
        out.print(
          [
            `state bucket   ${result.stateBucket}`,
            `terraform dir  ${result.terraformDir}`,
            result.configCreated
              ? "afk.config.json: created (edit `gitUrl`)"
              : "afk.config.json: already present",
            result.envCreated
              ? ".afk.env: created"
              : ".afk.env: already present",
            ``,
            `Next:`,
            `  1. cd ${result.terraformDir} && terraform init && terraform apply`,
            `  2. afk image build           # one-time golden AMI build (5-10 min)`,
            `  3. afk secrets put github-token <PAT>`,
            `  4. afk run "<your command>"`,
          ].join("\n"),
        ),
    })
  }),
)
