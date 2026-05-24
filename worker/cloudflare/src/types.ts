/**
 * Shared types between the launcher Worker, the RunDO, the RegistryDO, and
 * the AFK CLI's CloudflareCompute layer.
 *
 * The HTTP surface mirrors the abstract Compute interface in the CLI but is
 * concrete (JSON request/response shapes). Keep these in sync with
 * cli/src/services/backend/Compute.ts.
 */

/** Cloudflare bindings declared in wrangler.toml. */
export interface Env {
  readonly RUN_DO: DurableObjectNamespace
  readonly REGISTRY_DO: DurableObjectNamespace
  readonly RUN_CONTAINER: DurableObjectNamespace
  readonly DB: D1Database
  readonly DEVELOPERS_KV: KVNamespace
  /** CF API token used by `afk team add` to provision service tokens. */
  readonly CF_API_TOKEN?: string
  /** CF account ID — surfaced for the API calls that need it explicitly. */
  readonly CF_ACCOUNT_ID?: string
  /** This Worker's own script name, for self-targeting CF-API calls (secrets). */
  readonly WORKER_NAME?: string
  /** Catch-all for AFK_SECRET_* names — Workers Secrets that the Compute layer
   * resolves into the Container's env. Indexed at runtime by `env[name]`. */
  readonly [key: string]: unknown
}

export interface StartRequest {
  readonly runId: string
  readonly command: ReadonlyArray<string>
  readonly ref?: string
  readonly timeoutHours: number
  readonly image: string
  readonly branch: string
  readonly sha: string
  readonly mainService: string
  readonly repoName: string
  /** Public Worker URL, so the container can POST its completion callback. */
  readonly workerUrl?: string
  readonly env: ReadonlyArray<{ readonly name: string; readonly value: string }>
  /**
   * Names of Workers Secrets to inject into the Container's environment.
   * The Worker resolves these from its own env at spawn time.
   */
  readonly secretNames: ReadonlyArray<{ readonly name: string; readonly secretName: string }>
  /** Compose file content (already image-substituted, network_mode/extra_hosts auto-injected by the CLI). */
  readonly compose?: string
  readonly instanceTier?: string
}

export interface StartResponse {
  readonly runId: string
  readonly resourceId: string
  readonly status: "PROVISIONING"
  readonly startedAt: string
}

export interface RunMetadata {
  readonly runId: string
  readonly owner: string
  readonly branch: string
  readonly sha: string
  readonly image: string
  readonly repoName: string
  readonly startedAt: string
  readonly timeoutHours: number
  readonly status: "PROVISIONING" | "RUNNING" | "STOPPING" | "STOPPED"
  readonly mainService: string
  readonly instanceTier: string
}

export interface RunSummary extends RunMetadata {
  readonly resourceId: string
  readonly stoppedAt?: string
  readonly exitCode?: number
}

/** Auth context derived from the request headers, set by the Worker. */
export interface CallerPrincipal {
  readonly id: string // service-token client-id, or "local" in single-dev mode
  readonly displayName: string
}
