import { Schema } from "effect"

/**
 * Who a [[secret]] belongs to. A **team** secret is readable by every Run in the
 * project; a **personal** secret belongs to one [[owner]] and only that Owner's
 * Runs can read it (see CONTEXT.md "Secret").
 */
export const SecretScope = Schema.Literal("team", "personal")
export type SecretScope = typeof SecretScope.Type

export const Secret = Schema.Struct({
  name: Schema.String,
  scope: SecretScope,
  // Backend-neutral: where the value lives in the active store — an SSM
  // parameter path on AWS, the Workers Secret key on Cloudflare.
  reference: Schema.String,
  lastModified: Schema.optional(Schema.String),
})
export type Secret = typeof Secret.Type

/**
 * A personal secret's name is a path segment on AWS and a line key on GCP; the
 * charset `afk doctor` already accepts for `secret:<name>` fits both.
 */
export const isValidSecretName = (name: string): boolean =>
  /^[A-Za-z0-9._-]+$/.test(name)
