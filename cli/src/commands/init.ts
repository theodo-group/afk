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

const status = (created: boolean): string => (created ? "created" : "already present")

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
            `state bucket       ${result.stateBucket} (${status(result.stateBucketCreated)})`,
            `terraform dir      ${result.terraformDir} (${status(result.terraformDirCreated)})`,
            `afk.config.json    ${status(result.configCreated)}`,
            `.afk.env           ${status(result.envCreated)}`,
            `.gitignore         ${result.gitignoreUpdated ? "updated" : "already had .afk.env / .afk/"}`,
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
