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
 * Cloudflare-specific config block. Read only when `backend == "cloudflare"`.
 */
export const CloudflareBackendConfig = Schema.Struct({
  accountId: Schema.optional(Schema.String),
  workerName: Schema.optional(Schema.String),
  /** Smart placement (auto) or a regional pin like "weur", "wnam", "enam". */
  placement: Schema.optional(Schema.String),
  /** Container instance tier: dev | basic | standard-1 | standard-2 | standard-3 | standard-4. */
  defaultInstanceTier: Schema.optional(Schema.String),
  /**
   * Images pre-pulled into the CF Golden Container image by `afk golden build`.
   */
  cachedImages: Schema.optional(Schema.Array(Schema.String)),
})
export type CloudflareBackendConfig = typeof CloudflareBackendConfig.Type

/**
 * Legacy block from the very first config schema. Still parsed for backwards
 * compatibility but the value should migrate into `aws.cachedImages`.
 */
export const LegacyGoldenConfig = Schema.Struct({
  cachedImages: Schema.optional(Schema.Array(Schema.String)),
})
export type LegacyGoldenConfig = typeof LegacyGoldenConfig.Type

export const BackendName = Schema.Literal("aws", "cloudflare")
export type BackendName = typeof BackendName.Type

export const AfkConfig = Schema.Struct({
  backend: Schema.optional(BackendName),
  gitUrl: Schema.String,
  mainService: Schema.optional(Schema.String),
  defaultTimeoutHours: Schema.optional(Schema.Number),

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
