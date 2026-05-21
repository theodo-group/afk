import { Schema } from "effect"

export const Secret = Schema.Struct({
  name: Schema.String,
  ssmName: Schema.String,
  lastModified: Schema.optional(Schema.String),
})
export type Secret = typeof Secret.Type
