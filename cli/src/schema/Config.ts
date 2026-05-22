import { Schema } from "effect"

export const GoldenConfig = Schema.Struct({
  cachedImages: Schema.optional(Schema.Array(Schema.String)),
})
export type GoldenConfig = typeof GoldenConfig.Type

export const AwsBackendConfig = Schema.Struct({
  region: Schema.optional(Schema.String),
})
export type AwsBackendConfig = typeof AwsBackendConfig.Type

export const AfkConfig = Schema.Struct({
  backend: Schema.optional(Schema.Literal("aws")),
  gitUrl: Schema.String,
  mainService: Schema.optional(Schema.String),
  defaultInstanceType: Schema.optional(Schema.String),
  allowedInstanceTypes: Schema.optional(Schema.Array(Schema.String)),
  defaultTimeoutHours: Schema.optional(Schema.Number),
  golden: Schema.optional(GoldenConfig),
  aws: Schema.optional(AwsBackendConfig),
})
export type AfkConfig = typeof AfkConfig.Type

export const EnvEntry = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("plain"),
    name: Schema.String,
    value: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("ssm"),
    name: Schema.String,
    ssmName: Schema.String,
  }),
)
export type EnvEntry = typeof EnvEntry.Type
