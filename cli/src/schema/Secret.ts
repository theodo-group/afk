import { Schema } from "effect"

export const Secret = Schema.Struct({
  name: Schema.String,
  // Backend-neutral: where the value lives in the active store — an SSM
  // parameter path on AWS, the Workers Secret key on Cloudflare.
  reference: Schema.String,
  lastModified: Schema.optional(Schema.String),
})
export type Secret = typeof Secret.Type
