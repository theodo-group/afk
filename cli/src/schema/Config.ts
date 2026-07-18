import { Schema } from "effect"

/**
 * AWS-specific config block. Read only when `backend == "aws"`.
 */
export const AwsBackendConfig = Schema.Struct({
  region: Schema.optional(Schema.String),
  defaultInstanceType: Schema.optional(Schema.String),
  allowedInstanceTypes: Schema.optional(Schema.Array(Schema.String)),
  /**
   * Images pre-pulled into the Golden AMI by `afk golden build`. AWS-only.
   * On Cloudflare, see `cloudflare.cachedImages`.
   */
  cachedImages: Schema.optional(Schema.Array(Schema.String)),
})
export type AwsBackendConfig = typeof AwsBackendConfig.Type

/**
 * A custom Cloudflare Containers instance size: exact vCPU / memory / disk
 * instead of a named tier. Rendered by `afk provision` into wrangler.toml's
 * `instance_type` inline table (CF caps: 1–4 vCPU, ≤12 GiB memory, ≤20 GB
 * disk, ≥3 GiB memory per vCPU — enforced by Cloudflare at deploy time).
 */
export const CloudflareInstanceSpec = Schema.Struct({
  vcpu: Schema.Positive,
  memoryMib: Schema.Positive,
  diskMb: Schema.optional(Schema.Positive),
})
export type CloudflareInstanceSpec = typeof CloudflareInstanceSpec.Type

/** Human/one-line label for a tier value that may be a custom spec. */
export const cloudflareInstanceTierLabel = (
  tier: string | CloudflareInstanceSpec,
): string =>
  typeof tier === "string"
    ? tier
    : `custom(${tier.vcpu}vcpu/${tier.memoryMib}MiB${
        tier.diskMb !== undefined ? `/${tier.diskMb}MB` : ""
      })`

/**
 * Cloudflare-specific config block. Read only when `backend == "cloudflare"`.
 */
export const CloudflareBackendConfig = Schema.Struct({
  accountId: Schema.optional(Schema.String),
  workerName: Schema.optional(Schema.String),
  /**
   * HTTPS URL of the deployed launcher Worker (workers.dev or custom hostname).
   * Set after `wrangler deploy` — the CF Compute layer reads every operation's
   * target from here.
   */
  workerUrl: Schema.optional(Schema.String),
  /** Smart placement (auto) or a regional pin like "weur", "wnam", "enam". */
  placement: Schema.optional(Schema.String),
  /** Container instance size: a named tier (lite | basic | standard-1 …
   * standard-4) or a custom {vcpu, memoryMib, diskMb} spec. Deploy-time on CF:
   * `afk provision` writes it into wrangler.toml's `instance_type`, so changing
   * it requires a re-provision. */
  defaultInstanceTier: Schema.optional(
    Schema.Union(Schema.String, CloudflareInstanceSpec),
  ),
  /**
   * Images pre-pulled into the CF Golden Container image by `afk golden build`.
   */
  cachedImages: Schema.optional(Schema.Array(Schema.String)),
})
export type CloudflareBackendConfig = typeof CloudflareBackendConfig.Type

/**
 * Local-specific config block. Read only when `backend == "local"`.
 *
 * The Local Backend is fully self-contained — it makes no cloud calls — so the
 * only thing it needs from config is the list of sidecar images to bake into
 * the local Golden Image (the `docker:dind-rootless` boot artifact). Everything
 * else (gitUrl, mainService, timeout) comes from the Backend-neutral top level.
 */
export const LocalBackendConfig = Schema.Struct({
  /** Images pre-pulled into the local Golden Image by `afk golden build`. */
  cachedImages: Schema.optional(Schema.Array(Schema.String)),
})
export type LocalBackendConfig = typeof LocalBackendConfig.Type

/**
 * Legacy block from the very first config schema. Still parsed for backwards
 * compatibility but the value should migrate into `aws.cachedImages`.
 */
export const LegacyGoldenConfig = Schema.Struct({
  cachedImages: Schema.optional(Schema.Array(Schema.String)),
})
export type LegacyGoldenConfig = typeof LegacyGoldenConfig.Type

/**
 * GCP-specific config block. Read only when `backend == "gcp"`.
 */
export const GcpBackendConfig = Schema.Struct({
  projectId: Schema.optional(Schema.String),
  region: Schema.optional(Schema.String),
  zone: Schema.optional(Schema.String),
  defaultMachineType: Schema.optional(Schema.String),
  allowedMachineTypes: Schema.optional(Schema.Array(Schema.String)),
  /** Images pre-pulled into the GCE Golden custom image by `afk golden build`. */
  cachedImages: Schema.optional(Schema.Array(Schema.String)),
})
export type GcpBackendConfig = typeof GcpBackendConfig.Type

export const BackendName = Schema.Literal("aws", "cloudflare", "local", "gcp")
export type BackendName = typeof BackendName.Type

export const AfkConfig = Schema.Struct({
  backend: Schema.optional(BackendName),
  gitUrl: Schema.String,
  mainService: Schema.optional(Schema.String),
  defaultTimeoutHours: Schema.optional(Schema.Number),

  /**
   * Days a finished Run's compute primitive is retained — left stopped but
   * preserved so `afk attach` can resume it for post-mortem inspection — before
   * it is reclaimed. Honoured by the Local Backend only (cloud Backends
   * self-reclaim on exit), so it lives at the neutral top level rather than in a
   * Backend block. Absent ⇒ DEFAULT_RETENTION_DAYS.
   */
  retentionDays: Schema.optional(Schema.Number),

  /**
   * Session Artifacts (see CONTEXT.md): container-side path globs, resolved
   * inside the main service only, that afk collects at graceful Run end and
   * stores for later `afk session-artifact <run-id>` retrieval. Backend-neutral
   * (the artifact is the agent's, and the main service is a neutral concept), so
   * it lives at the top level rather than in a Backend block. Opt-in: absent or
   * empty means nothing is collected.
   */
  sessionArtifacts: Schema.optional(Schema.Array(Schema.String)),

  /**
   * Default instance type / tier picked when the dev passes no `--instance-type`
   * override. The value space is Backend-specific (EC2 type names on AWS, CF
   * instance tier names on Cloudflare). For backwards compatibility this also
   * accepts the legacy AWS-only field that was previously at the top level.
   */
  defaultInstanceType: Schema.optional(Schema.String),
  allowedInstanceTypes: Schema.optional(Schema.Array(Schema.String)),

  golden: Schema.optional(LegacyGoldenConfig), // backwards compat — migrate to aws.cachedImages
  aws: Schema.optional(AwsBackendConfig),
  cloudflare: Schema.optional(CloudflareBackendConfig),
  local: Schema.optional(LocalBackendConfig),
  gcp: Schema.optional(GcpBackendConfig),
})
export type AfkConfig = typeof AfkConfig.Type

export const EnvEntry = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("plain"),
    name: Schema.String,
    value: Schema.String,
  }),
  Schema.Struct({
    /**
     * A Backend-resolved secret reference. The `.afk.env` syntax is
     * `secret:<name>` (the canonical form) or `ssm:<path>` (the legacy AWS-only
     * form, still parsed). The Backend's SecretStore implementation knows how
     * to dereference the name at Run time.
     */
    kind: Schema.Literal("secret"),
    name: Schema.String,
    /** Canonical secret name (no prefix). */
    secretName: Schema.String,
  }),
)
export type EnvEntry = typeof EnvEntry.Type
