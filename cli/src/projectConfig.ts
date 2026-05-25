import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { config as loadDotenv } from "dotenv"

import { CONFIG_FILE } from "./constants.ts"

/**
 * Walk up from `start` to the directory holding `afk.config.json` (the project
 * root). Returns that directory, or `undefined` if the filesystem root is hit
 * first. Runs synchronously, before the Effect runtime exists — the layer stack
 * needs the project's env vars and Backend chosen before it can be composed, so
 * neither caller can be an Effect.
 */
const findProjectRoot = (dir: string = process.cwd()): string | undefined => {
  if (existsSync(resolve(dir, CONFIG_FILE))) return dir
  const parent = resolve(dir, "..")
  return parent === dir ? undefined : findProjectRoot(parent)
}

/**
 * Load the project's `.env` into `process.env` before anything reads env vars
 * (CLOUDFLARE_API_TOKEN, AFK_CF_CLIENT_ID, AWS_*, …). Loads the `.env` beside
 * `afk.config.json`, falling back to one in cwd when no config is found. dotenv
 * does not override variables already present in the environment, so an
 * explicitly-exported value still wins.
 */
export const loadProjectDotenv = (): void => {
  const root = findProjectRoot()
  if (root === undefined) {
    if (existsSync(resolve(process.cwd(), ".env"))) loadDotenv({ quiet: true })
    return
  }
  const envPath = resolve(root, ".env")
  if (existsSync(envPath)) loadDotenv({ path: envPath, quiet: true })
}

/**
 * Pick the Backend aggregate based on `afk.config.json`'s `backend` field.
 * Defaults to AWS so `afk init` itself still works in an empty directory.
 *
 * The Local Backend is reachable two ways (CONTEXT.md "Backend"): a persisted
 * `backend: "local"`, or a per-command `--local` override which wins regardless
 * of the persisted backend.
 */
export const pickBackendName = (): "aws" | "cloudflare" | "local" | "gcp" => {
  if (process.argv.includes("--local")) return "local"
  const root = findProjectRoot()
  if (root === undefined) return "aws"
  try {
    const parsed = JSON.parse(
      readFileSync(resolve(root, CONFIG_FILE), "utf8"),
    ) as {
      backend?: string
    }
    if (parsed.backend === "cloudflare") return "cloudflare"
    if (parsed.backend === "local") return "local"
    if (parsed.backend === "gcp") return "gcp"
    return "aws"
  } catch {
    return "aws"
  }
}
