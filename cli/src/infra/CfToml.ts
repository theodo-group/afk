/**
 * Pure helpers for the Cloudflare setup flow: deriving the account id from the
 * API token, and patching concrete resource ids into a rendered
 * `worker/afk/wrangler.toml` (and the workerUrl into `afk.config.json`).
 *
 * These are deliberately fs/string-level and Effect-free so they can be called
 * from BootstrapService (`afk init`), the golden build command, and the
 * `afk provision` command without dragging a service graph around.
 */
import { readFileSync, writeFileSync } from "node:fs"

/** Resolve the account id behind a Cloudflare API token. Picks the first
 * account; throws if the token sees zero or can't be read. */
export const deriveAccountId = async (apiToken: string): Promise<string> => {
  const res = await fetch("https://api.cloudflare.com/client/v4/accounts", {
    headers: { Authorization: `Bearer ${apiToken}` },
  })
  const body = (await res.json()) as {
    success: boolean
    result?: Array<{ id: string; name: string }>
    errors?: Array<{ message: string }>
  }
  if (!res.ok || !body.success) {
    const msg = body.errors?.map((e) => e.message).join("; ") ?? res.statusText
    throw new Error(`could not list Cloudflare accounts: ${msg}`)
  }
  const accounts = body.result ?? []
  if (accounts.length === 0) {
    throw new Error("API token is not scoped to any Cloudflare account")
  }
  return accounts[0]!.id
}

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
    toml = toml.replace(/account_id = "[^"]*"/, `account_id = "${patch.accountId}"`)
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
