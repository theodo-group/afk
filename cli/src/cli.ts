#!/usr/bin/env bun
import { Command, Options } from "@effect/cli"
import { Effect, Layer, Logger, LogLevel } from "effect"
import { BunContext, BunRuntime } from "@effect/platform-bun"

import { SubprocessLive } from "./infra/Subprocess.ts"
import { makeOutputLive } from "./infra/Output.ts"
import { consoleLogger } from "./infra/Logger.ts"

import { GitLive } from "./adapters/Git.ts"
import { DockerLive } from "./adapters/Docker.ts"
import { TerraformLive } from "./adapters/Terraform.ts"
import { StsLive } from "./adapters/aws/Sts.ts"
import { SsmLive } from "./adapters/aws/Ssm.ts"
import { LogsLive } from "./adapters/aws/Logs.ts"
import { EcrLive } from "./adapters/aws/Ecr.ts"
import { IamLive } from "./adapters/aws/Iam.ts"
import { S3Live } from "./adapters/aws/S3.ts"
import { Ec2Live } from "./adapters/aws/Ec2.ts"

import { ConfigServiceLive } from "./services/ConfigService.ts"
import { BuildServiceLive } from "./services/BuildService.ts"
import { ImageServiceLive } from "./services/ImageService.ts"
import { RunServiceLive } from "./services/RunService.ts"
import { SecretServiceLive } from "./services/SecretService.ts"
import { TeamServiceLive } from "./services/TeamService.ts"
import { BootstrapServiceLive } from "./services/BootstrapService.ts"

import { init } from "./commands/init.ts"
import { doctor } from "./commands/doctor.ts"
import { config as configCmd } from "./commands/config.ts"
import { build } from "./commands/build.ts"
import { image } from "./commands/image/index.ts"
import { run } from "./commands/run.ts"
import { ls } from "./commands/ls.ts"
import { logs } from "./commands/logs.ts"
import { attach } from "./commands/attach.ts"
import { kill } from "./commands/kill.ts"
import { secrets } from "./commands/secrets/index.ts"
import { team } from "./commands/team/index.ts"

// ---------- Global options ----------
const json = Options.boolean("json").pipe(
  Options.withDescription("emit machine-readable JSON instead of tables"),
)
const verbose = Options.boolean("verbose", { aliases: ["v"] }).pipe(
  Options.withDescription("debug logging"),
)
const quiet = Options.boolean("quiet", { aliases: ["q"] }).pipe(
  Options.withDescription("errors only"),
)

// ---------- Layers ----------
const L_infra = SubprocessLive

const L_adapters = Layer.mergeAll(
  GitLive,
  DockerLive,
  TerraformLive,
  StsLive,
  SsmLive,
  LogsLive,
  EcrLive,
  IamLive,
  S3Live,
  Ec2Live,
).pipe(Layer.provideMerge(L_infra))

const L_config = ConfigServiceLive.pipe(Layer.provideMerge(L_adapters))
const L_build = BuildServiceLive.pipe(Layer.provideMerge(L_config))
const L_image = ImageServiceLive.pipe(Layer.provideMerge(L_build))
const L_run = RunServiceLive.pipe(Layer.provideMerge(L_image))
const AppLive = Layer.mergeAll(
  SecretServiceLive,
  TeamServiceLive,
  BootstrapServiceLive,
).pipe(Layer.provideMerge(L_run))

// ---------- Root command ----------
const rootCommand = Command.make(
  "afk",
  { json, verbose, quiet },
  () =>
    Effect.sync(() => {
      console.log("Run `afk --help` for available commands.")
    }),
).pipe(
  Command.withSubcommands([
    init,
    doctor,
    configCmd,
    build,
    image,
    run,
    ls,
    logs,
    attach,
    kill,
    secrets,
    team,
  ]),
)

const cli = Command.run(rootCommand, {
  name: "afk",
  version: "0.0.0",
})

const program = Effect.gen(function* () {
  const argv = process.argv
  const isJson = argv.includes("--json")
  const isVerbose = argv.includes("--verbose") || argv.includes("-v")
  const isQuiet = argv.includes("--quiet") || argv.includes("-q")

  const OutputLive = makeOutputLive(isJson ? "json" : "table")
  const level = isQuiet
    ? LogLevel.Error
    : isVerbose
      ? LogLevel.Debug
      : LogLevel.Info

  yield* cli(argv).pipe(
    Effect.provide(OutputLive),
    Effect.provide(AppLive),
    Effect.provide(BunContext.layer),
    Effect.provide(consoleLogger),
    Logger.withMinimumLogLevel(level),
  )
})

BunRuntime.runMain(
  program.pipe(
    Effect.catchAllCause((cause) =>
      Effect.sync(() => {
        const failure = (cause as { failureOption?: () => unknown }).failureOption?.()
        const message =
          failure && typeof failure === "object" && failure !== null && "_tag" in failure
            ? renderAfkError(failure as { _tag: string; message?: string; hint?: string })
            : String(cause)
        console.error(message)
        process.exit(1)
      }),
    ),
  ),
)

function renderAfkError(err: {
  _tag: string
  message?: string
  hint?: string
}): string {
  const head = err.message ?? `${err._tag}`
  const tail = err.hint ? `\nhint: ${err.hint}` : ""
  return `error: ${head}${tail}`
}
