import { homedir } from "node:os"
import { resolve } from "node:path"
import { createHash } from "node:crypto"
import { mkdirSync } from "node:fs"

/**
 * Per-machine state layout for the Local Backend, all under `~/.afk`.
 *
 * The Local Backend is self-contained, so everything that the cloud Backends
 * keep in provider infra (secrets, Run history, per-Run scratch) lives here on
 * the developer's machine instead. Secrets are keyed by `gitUrl` (project
 * identity that survives a re-clone — see CONTEXT.md "Owner"); history is
 * machine-global and filtered by repo at query time.
 */
export const afkHome = (): string => resolve(homedir(), ".afk")

export const ensureDir = (dir: string): string => {
  mkdirSync(dir, { recursive: true })
  return dir
}

export const secretsDir = (): string => resolve(afkHome(), "secrets")

/** Filesystem-safe, stable identity for a project, derived from its gitUrl. */
export const projectSlug = (gitUrl: string): string =>
  createHash("sha256").update(gitUrl).digest("hex").slice(0, 16)

export const secretsFile = (gitUrl: string): string =>
  resolve(secretsDir(), `${projectSlug(gitUrl)}.json`)

export const historyFile = (): string => resolve(afkHome(), "history.jsonl")

export const runsDir = (): string => resolve(afkHome(), "runs")
export const runDir = (runId: string): string => resolve(runsDir(), runId)
export const runLogsDir = (runId: string): string =>
  resolve(runDir(runId), "logs")

/** Where the bootstrap `docker cp`s the declared Session Artifact base dirs at
 * graceful exit, and where the store reads them back from. Container-absolute
 * paths are mirrored under here (leading "/" dropped). */
export const runSessionArtifactsDir = (runId: string): string =>
  resolve(runDir(runId), "session-artifacts")
