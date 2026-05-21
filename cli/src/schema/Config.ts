import { Schema } from "effect"

export const AfkConfig = Schema.Struct({
  gitUrl: Schema.String,
  defaultCpu: Schema.optional(Schema.Number),
  defaultMemory: Schema.optional(Schema.Number),
  defaultTimeoutHours: Schema.optional(Schema.Number),
})
export type AfkConfig = typeof AfkConfig.Type

/** Parsed line from .afk.env */
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
