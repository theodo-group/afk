#!/usr/bin/env bun
import { Command, Options } from "@effect/cli"
import { Effect, Layer, Logger, LogLevel } from "effect"
import { FetchHttpClient } from "@effect/platform"
import { BunContext, BunRuntime } from "@effect/platform-bun"

import { SubprocessLive } from "./infra/Subprocess.ts"
import { renderCause } from "./infra/Errors.ts"
import { makeOutputLive, Output } from "./infra/Output.ts"
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
import { HistoryServiceLive } from "./services/HistoryService.ts"
import { RunServiceLive } from "./services/RunService.ts"
import { BootstrapServiceLive } from "./services/BootstrapService.ts"

import { AwsBackendLive } from "./backends/aws/index.ts"
import { CloudflareBackendLive } from "./backends/cloudflare/index.ts"
import { LocalBackendLive } from "./backends/local/index.ts"
import { loadProjectDotenv, pickBackendName } from "./projectConfig.ts"

import { init } from "./commands/init.ts"
import { provision } from "./commands/provision.ts"
import { destroy } from "./commands/destroy.ts"
import { doctor } from "./commands/doctor.ts"
import { config as configCmd } from "./commands/config.ts"
import { build } from "./commands/build.ts"
import { golden } from "./commands/golden/index.ts"
import { run } from "./commands/run.ts"
import { ls } from "./commands/ls.ts"
import { logs } from "./commands/logs.ts"
import { sessionArtifact } from "./commands/session-artifact.ts"
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
const local = Options.boolean("local").pipe(
  Options.withDescription(
    "run this command against the Local Backend (your own Docker daemon), overriding the persisted backend for this invocation",
  ),
)

// ---------- Layers ----------
//
// Layer composition (bottom to top):
//
//   Subprocess (infra)
//     └── adapter layer (Git, Docker, AWS SDK clients, Terraform, …)
//           └── ConfigService
//                 └── Backend layer (AwsBackendLive picks an Aws*Live for every
//                      abstract service tag — Compute, ImageRegistry,
//                      SecretStore, LogStore, RunHistory, GoldenImageStore)
//                      └── BuildService (cross-cutting, uses ImageRegistry)
//                            └── orchestrating services (RunService,
//                                 HistoryService) + Bootstrap
//
// Developer-facing secret CRUD goes straight to the SecretStore tag the Backend
// provides — there is no SecretService facade.
//
// To add another Backend (e.g. Cloudflare), replace `AwsBackendLive` with
// `CloudflareBackendLive` (or dispatch at runtime based on `config.backend`).

const infraLayer = SubprocessLive

const adaptersLayer = Layer.mergeAll(
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
).pipe(Layer.provideMerge(infraLayer))

const configLayer = ConfigServiceLive.pipe(Layer.provideMerge(adaptersLayer))

loadProjectDotenv()

const backendName = pickBackendName()

// Both backend aggregates declare different external deps (AWS adapters vs.
// Docker + Subprocess), so we can't take a single `pipe(Layer.provideMerge)`
// expression with a union value — TypeScript can't unify the two RIn shapes.
// Instead we branch and produce two fully-resolved backend layers; the
// downstream pipeline is identical from there.
const backendLayer =
  backendName === "cloudflare"
    ? CloudflareBackendLive.pipe(Layer.provideMerge(configLayer))
    : backendName === "local"
      ? LocalBackendLive.pipe(Layer.provideMerge(configLayer))
      : AwsBackendLive.pipe(Layer.provideMerge(configLayer))
const buildLayer = BuildServiceLive.pipe(Layer.provideMerge(backendLayer))
const runLayer = RunServiceLive.pipe(Layer.provideMerge(buildLayer))
const historyLayer = HistoryServiceLive.pipe(Layer.provideMerge(runLayer))
const AppLive = BootstrapServiceLive.pipe(Layer.provideMerge(historyLayer))

// ---------- Root command ----------
const rootCommand = Command.make("afk", { json, verbose, quiet, local }, () =>
  Effect.gen(function* () {
    const out = yield* Output
    yield* out.print("Run `afk --help` for available commands.")
  }),
).pipe(
  Command.withSubcommands([
    init,
    provision,
    destroy,
    doctor,
    configCmd,
    build,
    golden,
    run,
    ls,
    logs,
    sessionArtifact,
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
  const rawArgv = process.argv
  const isJson = rawArgv.includes("--json")
  const isVerbose = rawArgv.includes("--verbose") || rawArgv.includes("-v")
  const isQuiet = rawArgv.includes("--quiet") || rawArgv.includes("-q")

  // `--local` is consumed before the runtime by pickBackendName() (it selects
  // the Backend layer), so the @effect/cli parser must never see it. Strip it
  // here rather than declaring it on every command: that lets `--local` appear
  // anywhere on the line (`afk run --local <cmd>` as well as `afk --local run`)
  // without a variadic-args command swallowing it as a literal argument.
  const argv = rawArgv.filter((a) => a !== "--local")

  const OutputLive = makeOutputLive(isJson ? "json" : "table")
  const level = isQuiet
    ? LogLevel.Error
    : isVerbose
      ? LogLevel.Debug
      : LogLevel.Info

  // OutputLive is provided *outside* AppLive: backend layers (e.g. the
  // Provisioner) stream progress through the Output tag, so AppLive carries an
  // Output requirement that this outer provide satisfies.
  yield* cli(argv).pipe(
    Effect.provide(AppLive),
    Effect.provide(OutputLive),
    Effect.provide(BunContext.layer),
    Effect.provide(FetchHttpClient.layer),
    Effect.provide(consoleLogger),
    Logger.withMinimumLogLevel(level),
  )
})

BunRuntime.runMain(
  program.pipe(
    Effect.catchAllCause((cause) =>
      Effect.sync(() => {
        console.error(renderCause(cause))
        process.exit(1)
      }),
    ),
  ),
)
