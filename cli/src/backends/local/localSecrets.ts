import { existsSync, readFileSync } from "node:fs"
import { secretsFile } from "./localPaths.ts"

/**
 * On-disk shape of the Local Backend's secret store: one JSON file per project
 * (keyed by gitUrl) under `~/.afk/secrets/`, mapping secret name → value +
 * mtime. Plaintext at mode 0600, the same posture as `~/.aws/credentials`.
 *
 * Shared by `LocalSecretStore` (developer-facing CRUD) and `LocalCompute`
 * (which materialises the values into a Run's env file at launch — the local
 * analogue of the AWS VM resolving SSM at boot).
 */
export interface StoredSecret {
  readonly value: string
  readonly lastModified: string
}

export type SecretFile = Record<string, StoredSecret>

export const readSecretFile = (gitUrl: string): SecretFile => {
  const path = secretsFile(gitUrl)
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SecretFile
  } catch {
    return {}
  }
}

/** Resolve a single secret value, or undefined if not stored. */
export const readSecretValue = (gitUrl: string, name: string): string | undefined =>
  readSecretFile(gitUrl)[name]?.value
