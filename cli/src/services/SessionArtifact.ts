/**
 * Pure helpers for Session Artifact collection and retrieval (see CONTEXT.md
 * "Session Artifact"). No I/O, no Effect — the per-Backend stores gather the
 * effectful inputs (the on-disk file listing, the storage prefix) and call
 * these, which keeps the glob-matching and size-cap policy in one tested place.
 */

const GLOB_CHARS = /[*?[\]{}!()]/

/**
 * The longest leading run of literal (glob-free) path segments of a pattern,
 * as a directory. This is the coarsest path that still contains every possible
 * match, so it is what the orchestrator `docker cp`s out of the main service
 * container — the precise glob is then applied at retrieval against what was
 * collected.
 *
 *   /root/.claude/projects/**\/*.jsonl  →  /root/.claude/projects
 *   /root/.claude/session.jsonl         →  /root/.claude   (literal file → its dir)
 */
export const globBaseDir = (pattern: string): string => {
  const segments = pattern.split("/")
  const literal: Array<string> = []
  for (const segment of segments) {
    if (GLOB_CHARS.test(segment)) break
    literal.push(segment)
  }
  // A fully-literal pattern names a file; its base is the containing directory.
  if (literal.length === segments.length) literal.pop()
  return literal.join("/") || "/"
}

/**
 * The minimal set of directories to collect for a set of patterns: the distinct
 * base dirs, with any base that is nested under another dropped (its parent
 * already covers it). Keeps the orchestrator from copying the same tree twice.
 */
export const collectionBases = (
  patterns: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const bases = [...new Set(patterns.map(globBaseDir))].sort()
  return bases.filter(
    (base) =>
      !bases.some((other) => other !== base && base.startsWith(`${other}/`)),
  )
}

export interface ArtifactEntry {
  /** Absolute container-side path the file was collected from. */
  readonly path: string
  readonly size: number
}

export interface ArtifactSelection {
  /** Files matching a pattern and within the size cap — these are served. */
  readonly selected: ReadonlyArray<ArtifactEntry>
  /** Files matching a pattern but over the cap — skipped, never truncated. */
  readonly skipped: ReadonlyArray<ArtifactEntry>
}

/**
 * Apply the Session Artifact selection policy to a collected file listing:
 * keep files matching any declared pattern, then split on the size cap. A file
 * over the cap is reported as `skipped` (the caller warns), never truncated —
 * partial JSONL is worse than none.
 */
export const selectArtifacts = (
  entries: ReadonlyArray<ArtifactEntry>,
  patterns: ReadonlyArray<string>,
  capBytes: number,
): ArtifactSelection => {
  const globs = patterns.map((p) => new Bun.Glob(p))
  const matched = entries.filter((entry) =>
    globs.some((glob) => glob.match(entry.path)),
  )
  return {
    selected: matched.filter((entry) => entry.size <= capBytes),
    skipped: matched.filter((entry) => entry.size > capBytes),
  }
}
