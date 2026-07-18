import { Context, Effect } from "effect"
import {
  AwsError,
  CloudflareError,
  GcpError,
  ConfigError,
  DockerError,
  GitError,
  UserError,
} from "../../infra/Errors.ts"
import type { Run } from "../../schema/Run.ts"

/**
 * Input passed to `Compute.start` by RunService. Backend-neutral.
 *
 * Backend-specific overrides (instance type, on-demand, instance tier, colo)
 * arrive via the active backend's section of `afk.config.json`, not via this
 * input. The CLI flags that *do* surface to all backends are surfaced
 * generically here; backend-specific flags are not part of this interface and
 * are dispatched per-backend by the CLI layer.
 */
export interface StartInput {
  readonly command: ReadonlyArray<string>
  readonly ref?: string
  readonly timeoutHours?: number
  /**
   * Retain the compute primitive after the Run ends (stop instead of reclaim)
   * so `afk attach` can resume it for post-mortem inspection. Cloud-only and
   * On-Demand-only: a Spot Run cannot be retained (see CONTEXT.md "Retention").
   * The active backend enforces the capacity coupling and rejects it where
   * retention is impossible (Cloudflare).
   */
  readonly retain?: boolean
  /** Generic per-invocation overrides keyed by backend, validated by the active backend. */
  readonly backendOverrides?: Record<string, string | boolean | number>
  /**
   * Result of the cross-Backend image build, supplied by the orchestrator
   * (RunService). Compute does not call BuildService directly — that would
   * create a circular layer dependency (BuildService → ImageRegistry → backend
   * layer → Compute → BuildService).
   */
  readonly built: {
    readonly image: string
    readonly tag: string
    readonly sha: string
    readonly branch: string
    readonly skipped: boolean
  }
}

export interface RunStarted {
  readonly runId: string
  readonly resourceId: string
  readonly image: string
  readonly branch: string
  readonly sha: string
  readonly composeUsed: boolean
  /**
   * Free-form Backend-specific display fields the CLI surfaces to the user,
   * e.g. {instanceType: "t3.large", spot: "true"} on AWS or
   * {instanceTier: "standard-1", colo: "lhr"} on Cloudflare.
   */
  readonly backendDetails: Record<string, string>
  /**
   * Where logs land. AWS: CloudWatch log group name. Cloudflare: a label like
   * "Workers Logs (runId=…)".
   */
  readonly logChannel: string
}

/**
 * Backend-prepared launch plan. Treated as an opaque blob by RunService — only
 * the Backend that produced it knows how to launch it. The `runId` and a few
 * display fields are surfaced uniformly so `afk run --dry-run` can describe
 * what would happen without leaking AWS-shaped vs CF-shaped specifics into
 * the dispatcher. Backend-specific fields live in `backendPlan` (JSON-shaped).
 */
export interface PreparedRun {
  readonly runId: string
  /** The developer's command (from `afk run <args…>`), as exec argv. */
  readonly command: ReadonlyArray<string>
  readonly image: string
  readonly branch: string
  readonly sha: string
  readonly composeUsed: boolean
  readonly mainService: string
  readonly timeoutHours: number
  readonly timeoutSeconds: number
  readonly owner: string
  readonly repoName: string
  readonly env: ReadonlyArray<{ readonly name: string; readonly value: string }>
  readonly secrets: ReadonlyArray<{
    readonly name: string
    readonly secretName: string
  }>
  readonly logChannel: string
  /** Free-form Backend-specific data the same Backend's launch() consumes. */
  readonly backendPlan: Record<string, unknown>
}

export interface AttachOptions {
  readonly service?: string
  readonly host?: boolean
}

/**
 * Backend-neutral Run lifecycle interface. Each Backend implements this and
 * is wired into the layer composition selected from `afk.config.json`.
 */
export class Compute extends Context.Tag("Compute")<
  Compute,
  {
    /**
     * Identify the Backend at runtime. Used by `afk doctor` and surfaced in
     * `afk ls`/`afk history` output.
     */
    readonly backendName: "aws" | "cloudflare" | "local" | "gcp"

    /**
     * Resolve everything needed to launch a Run without launching anything.
     * Exposed separately from `launch` so `afk run --dry-run` can show the plan
     * and exit. The returned `PreparedRun` is opaque (backendPlan is Backend-
     * specific) but the top-level fields are uniform. `prepare` + `launch` is
     * orchestrated by RunService (where cross-cutting concerns belong), so the
     * Backend exposes only the two steps, never a fused `start`.
     */
    readonly prepare: (
      input: StartInput,
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

    /** Launch a previously-prepared plan. */
    readonly launch: (
      plan: PreparedRun,
    ) => Effect.Effect<
      RunStarted,
      AwsError | CloudflareError | GcpError | UserError | ConfigError
    >

    /** List Runs owned by a specific principal. */
    readonly listMine: (
      ownerUserId: string,
    ) => Effect.Effect<
      ReadonlyArray<Run>,
      AwsError | CloudflareError | GcpError | ConfigError | UserError
    >

    /** List every Run visible to the caller (admin scope). */
    readonly listAll: Effect.Effect<
      ReadonlyArray<Run>,
      AwsError | CloudflareError | GcpError | ConfigError | UserError
    >

    /** Resolve a Run by id. Returns UserError if not found. */
    readonly findByRunId: (
      runId: string,
    ) => Effect.Effect<
      Run,
      AwsError | CloudflareError | GcpError | UserError | ConfigError
    >

    /** Terminate a Run. */
    readonly kill: (
      runId: string,
    ) => Effect.Effect<
      void,
      AwsError | CloudflareError | GcpError | UserError | ConfigError
    >

    /** Open an interactive session into a running Run's main (or named) service. */
    readonly attach: (
      runId: string,
      opts: AttachOptions,
    ) => Effect.Effect<
      void,
      AwsError | CloudflareError | GcpError | UserError | ConfigError
    >

    /**
     * Get the caller's principal id for this Backend. AWS: STS UserId.
     * Cloudflare: Access service-token client-id (or "local" in single-dev mode).
     */
    readonly callerPrincipal: Effect.Effect<
      { readonly id: string; readonly displayName: string },
      AwsError | CloudflareError | GcpError | UserError | ConfigError
    >
  }
>() {}
