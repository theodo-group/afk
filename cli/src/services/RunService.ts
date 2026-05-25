import { Context, Effect, Fiber, Layer } from "effect"
import {
  Compute,
  type AttachOptions,
  type PreparedRun,
  type RunStarted,
} from "./backend/Compute.ts"
import { LogStore } from "./backend/LogStore.ts"
import { BuildService } from "./BuildService.ts"
import { ConfigService } from "./ConfigService.ts"
import type { Run, RunStatus } from "../schema/Run.ts"
import {
  AwsError,
  CloudflareError,
  GcpError,
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
      | AwsError
      | CloudflareError
      | GcpError
      | UserError
      | DockerError
      | GitError
      | ConfigError
    >
    readonly launch: (
      plan: PreparedRun,
    ) => Effect.Effect<
      RunStarted,
      AwsError | CloudflareError | GcpError | UserError | ConfigError
    >
    readonly start: (
      input: RunRequest,
    ) => Effect.Effect<
      RunStarted,
      | AwsError
      | CloudflareError
      | GcpError
      | UserError
      | DockerError
      | GitError
      | ConfigError
    >
    readonly listMine: (
      ownerUserId: string,
    ) => Effect.Effect<
      ReadonlyArray<Run>,
      AwsError | CloudflareError | GcpError | ConfigError | UserError
    >
    readonly listAll: Effect.Effect<
      ReadonlyArray<Run>,
      AwsError | CloudflareError | GcpError | ConfigError | UserError
    >
    readonly findByRunId: (
      runId: string,
    ) => Effect.Effect<
      Run,
      AwsError | CloudflareError | GcpError | UserError | ConfigError
    >
    readonly kill: (
      runId: string,
    ) => Effect.Effect<
      void,
      AwsError | CloudflareError | GcpError | UserError | ConfigError
    >
    readonly attach: (
      runId: string,
      opts: AttachOptions,
    ) => Effect.Effect<
      void,
      AwsError | CloudflareError | GcpError | UserError | ConfigError
    >
    /**
     * Follow a Run's logs to the terminal until it stops, then return. Backend-
     * neutral: it waits for the Run to reach RUNNING, tails via the `LogStore`
     * seam, and stops the tail once `findByRunId` reports a terminal state.
     * Best-effort — transient errors are tolerated and it never fails; Ctrl-C
     * interrupts it as a clean detach. This is what `afk run --follow` calls
     * instead of branching on the Backend.
     */
    readonly streamUntilTerminated: (
      runId: string,
      repoName: string,
    ) => Effect.Effect<void>
    /** Identifier of the active Backend (`"aws"`, `"cloudflare"`, `"local"`, `"gcp"`). */
    readonly backendName: "aws" | "cloudflare" | "local" | "gcp"
  }
>() {}

export const RunServiceLive = Layer.effect(
  RunService,
  Effect.gen(function* () {
    const compute = yield* Compute
    const build = yield* BuildService
    const cfg = yield* ConfigService
    const logs = yield* LogStore

    const isTerminal = (s: RunStatus): boolean =>
      s === "STOPPING" || s === "STOPPED"

    // Probe the Run's status, collapsing the two failure modes that matter to a
    // streamer: a not-found Run (UserError) means it's GONE; any other error is
    // TRANSIENT and worth retrying.
    const probeStatus = (
      runId: string,
    ): Effect.Effect<RunStatus | "GONE" | "TRANSIENT"> =>
      compute.findByRunId(runId).pipe(
        Effect.map((r): RunStatus | "GONE" | "TRANSIENT" => r.status),
        Effect.catchTag("UserError", () => Effect.succeed("GONE" as const)),
        Effect.catchAll(() => Effect.succeed("TRANSIENT" as const)),
      )

    const streamUntilTerminated = (runId: string, repoName: string) =>
      Effect.gen(function* () {
        yield* Effect.sync(() =>
          process.stderr.write("waiting for the Run to boot…"),
        )
        let status = yield* probeStatus(runId)
        // biome-ignore lint/plugin/noloops: time-gated poll — each pass depends on the previous probe plus a real sleep (code-style.md exception)
        while (status === "TRANSIENT" || status === "PROVISIONING") {
          yield* Effect.sync(() => process.stderr.write("."))
          yield* Effect.sleep("3 seconds")
          status = yield* probeStatus(runId)
        }
        if (status === "GONE" || isTerminal(status)) {
          yield* Effect.sync(() =>
            process.stderr.write(
              ` (${status === "GONE" ? "ended" : status.toLowerCase()})\n`,
            ),
          )
          return
        }
        yield* Effect.sync(() =>
          process.stderr.write(" ready, streaming logs (Ctrl-C to detach)\n"),
        )

        // Tail in a forked fiber so we can stop it the moment the Run goes
        // terminal. The LogStore tail kills its own subprocess on interruption.
        const tail = yield* Effect.fork(
          logs
            .tail({ runId, repoName, follow: true })
            .pipe(Effect.catchAll(() => Effect.void)),
        )

        let s: RunStatus | "GONE" | "TRANSIENT" = status
        // biome-ignore lint/plugin/noloops: time-gated poll — each pass depends on the previous probe plus a real sleep (code-style.md exception)
        while (!(s === "GONE" || (s !== "TRANSIENT" && isTerminal(s)))) {
          yield* Effect.sleep("6 seconds")
          s = yield* probeStatus(runId)
        }
        yield* Fiber.interrupt(tail)
      })

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
      streamUntilTerminated,
    })
  }),
)

// Re-export types for commands that import them.
export type {
  PreparedRun,
  RunStarted,
  AttachOptions,
} from "./backend/Compute.ts"
