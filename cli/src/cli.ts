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
import { DynamoDbLive } from "./adapters/aws/DynamoDb.ts"

import { ConfigServiceLive } from "./services/ConfigService.ts"
import { BuildServiceLive } from "./services/BuildService.ts"
import { ImageServiceLive } from "./services/ImageService.ts"
import { HistoryServiceLive } from "./services/HistoryService.ts"
import { RunServiceLive } from "./services/RunService.ts"
import { SecretServiceLive } from "./services/SecretService.ts"
import { TeamServiceLive } from "./services/TeamService.ts"
import { BootstrapServiceLive } from "./services/BootstrapService.ts"

import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

import { AwsBackendLive } from "./backends/aws/index.ts"
import { CloudflareBackendLive } from "./backends/cloudflare/index.ts"
import { CONFIG_FILE } from "./constants.ts"

import { init } from "./commands/init.ts"
import { doctor } from "./commands/doctor.ts"
import { config as configCmd } from "./commands/config.ts"
import { build } from "./commands/build.ts"
import { golden } from "./commands/golden/index.ts"
import { run } from "./commands/run.ts"
import { ls } from "./commands/ls.ts"
import { logs } from "./commands/logs.ts"
import { attach } from "./commands/attach.ts"
import { kill } from "./commands/kill.ts"
import { history } from "./commands/history.ts"
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
//
// Layer composition (bottom to top):
//
//   Subprocess (infra)
//     └── adapter layer (Git, Docker, AWS SDK clients, Terraform, …)
//           └── ConfigService
//                 └── ImageService (AWS-specific Golden Image builder)
//                       └── Backend layer (AwsBackendLive picks an Aws*Live
//                            for every abstract service tag — Compute,
//                            ImageRegistry, SecretStore, LogStore, RunHistory)
//                            └── BuildService (cross-cutting, uses ImageRegistry)
//                                  └── facade services (RunService, SecretService,
//                                       HistoryService) + Bootstrap + Team
//
// To add another Backend (e.g. Cloudflare), replace `AwsBackendLive` with
// `CloudflareBackendLive` (or dispatch at runtime based on `config.backend`).

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
  DynamoDbLive,
).pipe(Layer.provideMerge(L_infra))

const L_config = ConfigServiceLive.pipe(Layer.provideMerge(L_adapters))
const L_image = ImageServiceLive.pipe(Layer.provideMerge(L_config))

/**
 * Pick the Backend aggregate based on `afk.config.json`'s `backend` field.
 *
 * Synchronously walks up from cwd looking for the config file (the same logic
 * ConfigService uses, duplicated here because the Layer must be selected
 * before the Effect runtime is up). Defaults to AWS so `afk init` itself
 * still works in an empty directory.
 */
const pickBackendName = (): "aws" | "cloudflare" => {
  let dir = process.cwd()
  while (true) {
    const candidate = resolve(dir, CONFIG_FILE)
    if (existsSync(candidate)) {
      try {
        const raw = readFileSync(candidate, "utf8")
        const parsed = JSON.parse(raw) as { backend?: string }
        if (parsed.backend === "cloudflare") return "cloudflare"
        return "aws"
      } catch {
        return "aws"
      }
    }
    const parent = resolve(dir, "..")
    if (parent === dir) return "aws"
    dir = parent
  }
}

const _backendName = pickBackendName()

// Both backend aggregates declare different external deps (AWS adapters vs.
// Docker + Subprocess), so we can't take a single `pipe(Layer.provideMerge)`
// expression with a union value — TypeScript can't unify the two RIn shapes.
// Instead we branch and produce two fully-resolved L_backend layers; the
// downstream pipeline is identical from there.
const L_backend =
  _backendName === "cloudflare"
    ? CloudflareBackendLive.pipe(Layer.provideMerge(L_image))
    : AwsBackendLive.pipe(Layer.provideMerge(L_image))
const L_build = BuildServiceLive.pipe(Layer.provideMerge(L_backend))
const L_run = RunServiceLive.pipe(Layer.provideMerge(L_build))
const L_history = HistoryServiceLive.pipe(Layer.provideMerge(L_run))
const AppLive = Layer.mergeAll(
  SecretServiceLive,
  TeamServiceLive,
  BootstrapServiceLive,
).pipe(Layer.provideMerge(L_history))

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
    golden,
    run,
    ls,
    logs,
    attach,
    kill,
    history,
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
