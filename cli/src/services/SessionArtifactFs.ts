import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs"
import { dirname, resolve, sep } from "node:path"
import { type ArtifactEntry, selectArtifacts } from "./SessionArtifact.ts"
import { SESSION_ARTIFACT_MAX_BYTES } from "../constants.ts"

export interface RetrieveResult {
  /** Absolute local paths written under `outDir`. */
  readonly written: ReadonlyArray<string>
  /** Container-side paths that matched but were skipped for exceeding the cap. */
  readonly skipped: ReadonlyArray<string>
}

/**
 * Shared retrieval glue for the file-backed Session Artifact stores (Local off
 * the scratch dir, AWS off an S3 prefix synced to a temp dir). The collected
 * tree mirrors the container's absolute layout with the leading "/" dropped, so
 * this walks it, reconstructs each container-absolute path, applies the precise
 * globs + size cap via `selectArtifacts`, and copies the survivors into
 * `outDir` preserving structure.
 *
 * Pure-ish by design: all the policy lives in the tested `selectArtifacts`; this
 * is the unavoidable filesystem shell around it, kept in one place so the two
 * stores can't drift.
 */
export const retrieveFromCollectedDir = (
  collectedDir: string,
  patterns: ReadonlyArray<string>,
  outDir: string,
  capBytes: number = SESSION_ARTIFACT_MAX_BYTES,
): RetrieveResult => {
  if (!existsSync(collectedDir)) return { written: [], skipped: [] }

  const entries: Array<ArtifactEntry> = []
  for (const rel of readdirSync(collectedDir, {
    recursive: true,
  }) as Array<string>) {
    const abs = resolve(collectedDir, rel)
    if (!statSync(abs).isFile()) continue
    entries.push({
      path: `/${rel.split(sep).join("/")}`,
      size: statSync(abs).size,
    })
  }

  const { selected, skipped } = selectArtifacts(entries, patterns, capBytes)

  const written: Array<string> = []
  for (const entry of selected) {
    const rel = entry.path.replace(/^\//, "")
    const dest = resolve(outDir, rel)
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(resolve(collectedDir, rel), dest)
    written.push(dest)
  }

  return { written, skipped: skipped.map((s) => s.path) }
}
