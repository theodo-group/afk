import { Context, Effect, Layer } from "effect"
import { Compute, type AttachOptions, type PreparedRun, type RunStarted } from "./backend/Compute.ts"
import { BuildService } from "./BuildService.ts"
import { ConfigService } from "./ConfigService.ts"
import type { Run } from "../schema/Run.ts"
import {
  AwsError,
  CloudflareError,
  ConfigError,
  DockerError,
  GitError,
  UserError,
} from "../infra/Errors.ts"
import { DEFAULT_REGION } from "../constants.ts"

/**
 * Public input to RunService — the subset of fields a CLI command resolves
 * from flags + config. Image-build details (image URI, sha, branch) are
 * filled in by RunService itself before calling Compute.
 */
export interface RunRequest {
  readonly command: ReadonlyArray<string>
  readonly ref?: string
  readonly timeoutHours?: number
  readonly backendOverrides?: Record<string, string | boolean | number>
}

/**
 * Run lifecycle, abstracted across Backends.
 *
 * RunService is the orchestrator: it runs the cross-Backend pieces (image
 * build via BuildService, region/config resolution) and then delegates the
 * Backend-specific compute lifecycle to the active `Compute` layer.
 *
 * It exists so the CLI commands can depend on a single tag rather than
 * knowing about the Compute interface directly. Add cross-cutting concerns
 * (audit logging, retries, etc.) here, not in the Backend impls.
 */
export class RunService extends Context.Tag("RunService")<
  RunService,
  {
    readonly prepare: (
      input: RunRequest,
    ) => Effect.Effect<
      PreparedRun,
      AwsError | CloudflareError | UserError | DockerError | GitError | ConfigError
    >
    readonly launch: (
      plan: PreparedRun,
    ) => Effect.Effect<RunStarted, AwsError | CloudflareError | UserError | ConfigError>
    readonly start: (
      input: RunRequest,
    ) => Effect.Effect<
      RunStarted,
      AwsError | CloudflareError | UserError | DockerError | GitError | ConfigError
    >
    readonly listMine: (
      ownerUserId: string,
    ) => Effect.Effect<ReadonlyArray<Run>, AwsError | CloudflareError | ConfigError | UserError>
    readonly listAll: Effect.Effect<
      ReadonlyArray<Run>,
      AwsError | CloudflareError | ConfigError | UserError
    >
    readonly findByRunId: (
      runId: string,
    ) => Effect.Effect<Run, AwsError | CloudflareError | UserError | ConfigError>
    readonly kill: (
      runId: string,
    ) => Effect.Effect<void, AwsError | CloudflareError | UserError | ConfigError>
    readonly attach: (
      runId: string,
      opts: AttachOptions,
    ) => Effect.Effect<void, AwsError | CloudflareError | UserError | ConfigError>
    /** Identifier of the active Backend (`"aws"`, `"cloudflare"`, …). */
    readonly backendName: "aws" | "cloudflare"
  }
>() {}

export const RunServiceLive = Layer.effect(
  RunService,
  Effect.gen(function* () {
    const compute = yield* Compute
    const build = yield* BuildService
    const cfg = yield* ConfigService

    const prepare = (input: RunRequest) =>
      Effect.gen(function* () {
        const { config } = yield* cfg.load
        const region = config.aws?.region ?? DEFAULT_REGION
        const built = yield* build.build({ region, ref: input.ref })
        return yield* compute.prepare({
          command: input.command,
          ref: input.ref,
          timeoutHours: input.timeoutHours,
          backendOverrides: input.backendOverrides,
          built,
        })
      })

    return RunService.of({
      backendName: compute.backendName,
      prepare,
      launch: compute.launch,
      start: (input) =>
        Effect.gen(function* () {
          const plan = yield* prepare(input)
          return yield* compute.launch(plan)
        }),
      listMine: compute.listMine,
      listAll: compute.listAll,
      findByRunId: compute.findByRunId,
      kill: compute.kill,
      attach: compute.attach,
    })
  }),
)

// Re-export types for commands that import them.
export type { PreparedRun, RunStarted, AttachOptions } from "./backend/Compute.ts"
