# Architecture

The `afk` CLI is one Bun/TypeScript program built on [Effect](https://effect.website)
(v3) and `@effect/cli`. It is wired together as a stack of Effect `Layer`s in
`cli/src/cli.ts`. This document explains the shape that stack imposes.

## The one idea

The CLI surface is **identical across cloud providers** — `afk run`, `afk attach`,
`afk ls`, `afk kill` mean the same thing on AWS EC2 or Cloudflare Containers.
One rule buys this:

> **Commands and orchestrating services depend only on Backend-neutral
> interface tags. Provider code lives behind those tags and is chosen once, at
> startup, from `afk.config.json`.**

No command imports `AwsCompute` or `CloudflareCompute`; it imports the `Compute`
tag. Which implementation answers the tag is a layer-composition decision
(`cli.ts:175`), invisible to commands.

## Layers (the directories)

Source lives under `cli/src/`. Each directory is a tier that may depend
*downward* but never *upward*.

```
cli/src/
├── cli.ts              Entry point. Composes every Layer; selects the Backend.
├── constants.ts        SCREAMING_SNAKE_CASE constants. No logic.
│
├── infra/              Lowest tier. No domain knowledge.
│   ├── Subprocess.ts     Bun.spawn behind a tag — everything shells out here.
│   ├── Errors.ts         Every Data.TaggedError + the AfkError union.
│   ├── Output.ts         table-vs-json rendering (the Output tag).
│   ├── Logger.ts / CfToml.ts
│
├── adapters/           Thin one-tag wrappers over external tools/SDKs.
│   ├── Git.ts, Docker.ts, Terraform.ts
│   └── aws/              Sts, Ec2, S3, Ecr, Ssm, Iam, Logs, DynamoDb
│
├── schema/             effect Schema definitions + branded types.
│   └── Run.ts, Config.ts, Secret.ts, TeamMember.ts
│
├── services/           Backend-neutral business logic.
│   ├── backend/          Interface tags only — NO implementations.
│   │   └── Compute.ts, ImageRegistry.ts, SecretStore.ts, LogStore.ts,
│   │       RunHistory.ts, GoldenImage.ts, BackendDoctor.ts, Team.ts,
│   │       Provisioner.ts
│   ├── RunService.ts      Orchestrator: build image, delegate to Compute, stream logs.
│   └── BuildService, ConfigService, HistoryService, TeamService, BootstrapService,
│       Compose, RunPlan, GoldenImageVersion, Pricing, UserData
│
├── backends/           Provider implementations of services/backend/.
│   ├── aws/              AwsCompute, AwsImageRegistry, … + index.ts aggregate
│   ├── cloudflare/       CloudflareCompute, …            + index.ts aggregate
│   └── local/            LocalCompute, …  (rootless dind) + index.ts aggregate
│
└── commands/           @effect/cli Command definitions, one per file.
    └── golden/, secrets/, team/   subcommand groups (each an index.ts dispatcher)
```

```
commands  →  services (incl. backend/ interface tags)  →  adapters  →  infra
                  ↑
            backends/* provide the backend/ interface tags
```

A command that needs provider data asks a service; it never reaches into
`backends/` or `adapters/` directly.

## The Backend abstraction (three parts)

The spine of the codebase.

**1. Interface — `services/backend/*.ts`.** A `Context.Tag` class describing one
capability in neutral terms. Each operation's error channel is the union of all
backends' error types, so the caller's type is stable across backends.

```ts
// services/backend/Compute.ts
export class Compute extends Context.Tag("Compute")<
  Compute,
  {
    readonly backendName: "aws" | "cloudflare" | "local"
    readonly prepare: (input: StartInput) => Effect.Effect<PreparedRun, …>
    readonly launch:  (plan: PreparedRun) => Effect.Effect<RunStarted, …>
    // …kill, listMine, listAll, findByRunId, attach, callerPrincipal
  }
>() {}
```

`prepare`/`launch` are split deliberately: `prepare` resolves the whole Run Plan
without launching (what `afk run --dry-run` prints); `launch` is the single
irreversible step. RunService orchestrates the two (and owns log streaming via
`streamUntilTerminated`), so the Backend exposes no fused `start`.

**2. Implementations — `backends/<provider>/*.ts`.** One `Layer.effect` per tag.
Backends map native concepts onto neutral ones (e.g. `schema/Run.ts` collapses
EC2 / CF / local-container states into `RunStatus`: `PROVISIONING | RUNNING |
STOPPING | STOPPED`).

```ts
// backends/aws/AwsCompute.ts
export const AwsComputeLive = Layer.effect(
  Compute,
  Effect.gen(function* () {
    const ec2 = yield* Ec2
    const history = yield* RunHistory      // intra-backend dependency
    return Compute.of({ backendName: "aws", prepare: …, launch: …, /* … */ })
  }),
)
```

**3. Aggregate — `backends/<provider>/index.ts`.** Merges the provider's leaf
layers into one `XxxBackendLive`, wiring intra-backend deps with
`Layer.provideMerge` (`AwsCompute` consumes `RunHistory` to record starts, so
the leaves are provided *into* it and re-exported for other services):

```ts
// backends/aws/index.ts
const Leaves = Layer.mergeAll(
  AwsImageRegistryLive, AwsSecretStoreLive, AwsLogStoreLive,
  AwsRunHistoryLive, AwsGoldenImageLive, AwsBackendDoctorLive,
  AwsTeamLive,
)
export const AwsBackendLive = AwsComputeLive.pipe(Layer.provideMerge(Leaves))
```

**Adding a Backend:** implement the nine `services/backend/` tags (Compute,
ImageRegistry, SecretStore, LogStore, RunHistory, GoldenImageStore,
BackendDoctor, Team, Provisioner) under `backends/<new>/`, write
`<New>BackendLive` in its `index.ts`, add one branch to `cli.ts`. No command
changes.

## Layer composition in `cli.ts`

`cli.ts` builds the app as one `AppLive` layer, bottom to top — the dependency
gradient made concrete:

```
SubprocessLive (infra)
  └─ adapters (Git, Docker, Terraform, AWS SDK clients)   L_adapters
       └─ ConfigService                                   L_config
            └─ <Backend>BackendLive                       L_backend   ← selected here
                 └─ BuildService                          L_build
                      └─ RunService                       L_run
                           └─ HistoryService              L_history
                                └─ Team/Bootstrap          AppLive
```

Two subtleties before editing this file:

- **The Backend is picked synchronously, before the runtime exists.**
  `pickBackendName()` walks up from cwd, reads `afk.config.json`, returns `"aws"`
  (default), `"cloudflare"`, or `"local"` — a layer can't be selected from inside
  an Effect because the layer *provides* the runtime. The aggregates have
  different external deps (AWS SDK vs Docker) and can't be unified into one
  value, so `cli.ts` branches into three fully-resolved `L_backend`s; downstream
  is identical. `pickBackendName()` also checks `argv` for `--local` *first* — the
  Local Backend is reachable both as the persisted `backend` and as a
  per-command override (the only Backend with two selection channels). Because
  `--local` is consumed here, before the runtime, the `program` strips it from
  the argv handed to `@effect/cli` so a command's args never swallow it.
- **`.env` loads even earlier.** `loadProjectDotenv()` runs at import time,
  walking up to the project root and loading the `.env` beside `afk.config.json`.
  It does not override already-exported variables.

Output mode and log level come from `argv` (`--json/--verbose/--quiet`) and are
provided as separate layers at the call site. `OutputLive` is provided *outside*
`AppLive` (after it in the provide chain): backend layers stream progress through
the `Output` tag (the `Provisioner` prints its `terraform`/`wrangler` steps), so
`AppLive` carries an `Output` requirement this outer provide satisfies.

**No cross-backend stubs.** Every command depends only on neutral tags resolved
by the active aggregate, so no aggregate stubs another's impls. (An earlier
design stubbed the inactive backend's golden builder to keep `AppLive`'s type
resolved; folding every builder into the one `GoldenImageStore` seam removed the
need.)

## Request flow: `afk run`

1. `commands/run.ts` parses flags, packs `--instance-type`/`--on-demand`/etc.
   into a neutral `backendOverrides` bag, `yield* RunService`.
2. `RunService.prepare` loads config, runs the cross-Backend image build via
   `BuildService`, hands a neutral `StartInput` to `Compute.prepare`. RunService
   is the orchestrator — cross-cutting concerns (audit, retries) belong here, not
   in the backend.
3. `Compute.prepare` (active `backends/*/…Compute.ts`) resolves the full
   `PreparedRun`, provider specifics in its opaque `backendPlan`.
4. `--dry-run` stops here and prints via `Output.emit`. Otherwise
   `Compute.launch` performs the irreversible launch, returns a neutral
   `RunStarted`.
5. Unless `--detach`, the command calls `RunService.streamUntilTerminated` —
   backend-neutral: it waits for the Run to reach RUNNING, tails via the
   `LogStore` seam, and stops the tail (fiber interruption) once `findByRunId`
   reports a terminal state. No `backendName` branch.

## Output

All terminal output goes through the `Output` tag (`infra/Output.ts`) via
`out.emit({ data, human })`: `--json` mode prints `data` as JSON, otherwise calls
`human(data)`. Commands never `console.log` results — that bypasses `--json`.

## Logs

`afk logs <run>` has three scopes: default = the **main service** (the agent),
`--service <name>` = one service, `--all` = every service. The command owns the
policy — it resolves the default to `mainService` from config and passes it as
the `LogStore` tag's `serviceFilter` (`--all` passes none). Backends just honour
"this service / all".

Run-id is optional: omitted with a TTY, the command prompts (`Prompt.select`)
from recent `HistoryService` rows so the developer picks a Run instead of
copying an id; omitted without a TTY it errors rather than hang a pipe.

Every Backend keys logs per service so the filter works identically.
AWS: per-service CloudWatch streams — the compose path injects a per-service
`logging.options.awslogs-stream: <runId>/<service>` at submit time (the daemon
default `{{.Name}}` is the *container* name, which doesn't match). CF: no log
driver, so
the golden bootstrap captures `docker compose logs` per service and POSTs a
`{ exitCode, services: { <name>: <b64> } }` map to `/runs/:id/complete`; sidecars
get a tighter truncation budget than the main service. Local: the outer
container's bootstrap streams each service's `docker compose logs` *live* into a
bind-mounted `logs/<service>.log` (plus a prefixed `combined.log` for `--all`),
which the CLI reads straight off disk — so scoping is correct while the Run is
alive, not just after exit.

## Errors

Failures travel in the Effect error channel — never thrown — as
`Data.TaggedError` subclasses in `infra/Errors.ts`, unioned as `AfkError`. The
sole render point is the top-level `catchAllCause` in `cli.ts`
(`error: <message>` + optional `hint:`).

## Outside the CLI

These do not use Effect and follow their own conventions:

- **`worker/cloudflare/`** — launcher Worker. Hono + Durable Objects, async/await.
- **`terraform/aws/`** — HCL.
- **`terraform/aws/lambda/sweeper/`** — TypeScript Lambda, plain AWS SDK.
- **`entrypoint/entrypoint.sh`** — CLI-owned bash entrypoint baked into agent
  images at build time.

## Tests

None yet. They will run under `bun test` (`*.test.ts`). Because everything is
layer-composed, the testing seam is to provide a tag with a fake `Layer.succeed`
and exercise the service above it.
