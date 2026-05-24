/**
 * Helpers for the Cloudflare setup flow: deriving the account id from the API
 * token, and patching concrete resource ids into a rendered
 * `worker/afk/wrangler.toml` (and the workerUrl into `afk.config.json`).
 *
 * The toml/config patchers are deliberately fs/string-level and Effect-free so
 * `afk init`, the golden build, and `afk provision` can call them without
 * dragging a service graph around. `deriveAccountId` is the exception: it makes
 * a network call, so it is an Effect over the `HttpClient` seam.
 */
import { HttpClient, HttpClientResponse } from "@effect/platform"
import { Effect, Schema } from "effect"
import { readFileSync, writeFileSync } from "node:fs"

import { CloudflareError, UserError } from "./Errors.ts"

const CF_ACCOUNTS_URL = "https://api.cloudflare.com/client/v4/accounts"

const CfAccountsResponse = Schema.Struct({
  success: Schema.Boolean,
  result: Schema.optional(
    Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
  ),
  errors: Schema.optional(
    Schema.Array(Schema.Struct({ message: Schema.String })),
  ),
})

/**
 * Resolve the account id behind a Cloudflare API token, picking the first
 * account. Fails with `UserError` when the token is scoped to zero accounts
 * (developer-fixable) and `CloudflareError` for any transport/decode failure.
 */
export const deriveAccountId = (
  apiToken: string,
): Effect.Effect<string, CloudflareError | UserError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const res = yield* HttpClient.get(CF_ACCOUNTS_URL, {
      headers: { Authorization: `Bearer ${apiToken}` },
    })
    const body =
      yield* HttpClientResponse.schemaBodyJson(CfAccountsResponse)(res)
    if (!body.success) {
      const msg =
        body.errors?.map((e) => e.message).join("; ") ?? `HTTP ${res.status}`
      return yield* Effect.fail(
        new CloudflareError({
          operation: "init:accountId",
          status: res.status,
          message: `could not list Cloudflare accounts: ${msg}`,
        }),
      )
    }
    const first = (body.result ?? [])[0]
    if (first === undefined) {
      return yield* Effect.fail(
        new UserError({
          message: "API token is not scoped to any Cloudflare account.",
          hint: "Grant the token access to at least one account, then re-run.",
        }),
      )
    }
    return first.id
  }).pipe(
    Effect.scoped,
    Effect.catchTags({
      RequestError: (cause) =>
        Effect.fail(
          new CloudflareError({
            operation: "init:accountId",
            message: `could not reach the Cloudflare API: ${cause.message}`,
          }),
        ),
      ResponseError: (cause) =>
        Effect.fail(
          new CloudflareError({
            operation: "init:accountId",
            message: `unexpected Cloudflare API response: ${cause.message}`,
          }),
        ),
      ParseError: (cause) =>
        Effect.fail(
          new CloudflareError({
            operation: "init:accountId",
            message: `could not parse the Cloudflare accounts response: ${cause.message}`,
          }),
        ),
    }),
  )

export interface WranglerTomlPatch {
  readonly accountId?: string
  readonly databaseId?: string
  readonly kvId?: string
  readonly imageUri?: string
}

/**
 * Patch concrete values into a wrangler.toml in place. Each field is optional;
 * only provided ones are touched. Idempotent — re-running with the same values
 * is a no-op, and it overwrites prior values (including `REPLACE_ME`).
 */
export const patchWranglerToml = (
  path: string,
  patch: WranglerTomlPatch,
): void => {
  let toml = readFileSync(path, "utf8")

  if (patch.accountId !== undefined) {
    toml = toml.replace(
      /account_id = "[^"]*"/,
      `account_id = "${patch.accountId}"`,
    )
    toml = toml.replace(
      /CF_ACCOUNT_ID = "[^"]*"/,
      `CF_ACCOUNT_ID = "${patch.accountId}"`,
    )
  }
  if (patch.databaseId !== undefined) {
    toml = toml.replace(
      /database_id = "[^"]*"/,
      `database_id = "${patch.databaseId}"`,
    )
  }
  if (patch.kvId !== undefined) {
    toml = toml.replace(
      /(binding = "DEVELOPERS_KV"\s*\n\s*id = ")[^"]*(")/,
      `$1${patch.kvId}$2`,
    )
  }
  if (patch.imageUri !== undefined) {
    toml = toml.replace(
      /image = "registry\.cloudflare\.com\/[^"]*"/,
      `image = "${patch.imageUri}"`,
    )
  }

  writeFileSync(path, toml)
}

/** Set `cloudflare.workerUrl` in an afk.config.json, preserving everything else. */
export const patchConfigWorkerUrl = (
  configPath: string,
  workerUrl: string,
): void => {
  const cfg = JSON.parse(readFileSync(configPath, "utf8")) as {
    cloudflare?: Record<string, unknown>
    [k: string]: unknown
  }
  cfg.cloudflare = { ...(cfg.cloudflare ?? {}), workerUrl }
  writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n")
}
