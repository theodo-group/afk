import { Schema } from "effect"

export const RunId = Schema.String.pipe(Schema.brand("RunId"))
export type RunId = typeof RunId.Type

/**
 * Status of a Run, in Backend-neutral terms.
 *
 * Each Backend maps its native states into these four:
 *   AWS EC2:      pending → PROVISIONING; running → RUNNING;
 *                 shutting-down|stopping → STOPPING; stopped|terminated → STOPPED.
 *   Cloudflare:   starting → PROVISIONING; running → RUNNING;
 *                 stopping → STOPPING; stopped|destroyed → STOPPED.
 */
export const RunStatus = Schema.Literal(
  "PROVISIONING",
  "RUNNING",
  "STOPPING",
  "STOPPED",
)
export type RunStatus = typeof RunStatus.Type

export const BackendName = Schema.Literal("aws", "cloudflare", "local")
export type BackendName = typeof BackendName.Type

/**
 * Backend-neutral Run record. The fields here are the ones every Backend
 * surfaces; provider-specific metadata (EC2 instance type, CF instance tier,
 * spot/colo/etc.) lives in `backendDetails`.
 */
export const Run = Schema.Struct({
  runId: RunId,
  /** Opaque per-Backend handle. EC2 instance-id on AWS; DO ID on Cloudflare. */
  resourceId: Schema.String,
  status: RunStatus,
  owner: Schema.String,
  branch: Schema.String,
  sha: Schema.String,
  image: Schema.String,
  backend: BackendName,
  /** Free-form Backend-specific display fields, e.g. {instanceType, spot} on AWS. */
  backendDetails: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.String }),
  ),
  startedAt: Schema.optional(Schema.String),
  stoppedAt: Schema.optional(Schema.String),
  stopReason: Schema.optional(Schema.String),
  /**
   * For a retained (STOPPED) Run: when its compute primitive will be
   * auto-reclaimed (stoppedAt + retentionDays). Its presence is what marks a
   * STOPPED Run as still resumable via `afk attach`. Set by the Local Backend
   * only; absent on Backends that reclaim immediately.
   */
  retainedUntil: Schema.optional(Schema.String),
})
export type Run = typeof Run.Type
