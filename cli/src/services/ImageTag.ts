import { createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { CONTENT_TAG_PREFIX } from "../constants.ts"

/**
 * Content-addressed image tags (`image.tag: "content"` in afk.config.json).
 *
 * The default tag is `<branch>-<sha12>`: one image per commit, rebuilt (from
 * cache) and re-pushed on every launch, even when nothing the image is made of
 * changed. For a project whose afk.Dockerfile holds only tooling — the source is
 * cloned by the entrypoint, never baked in — that image is the same for every
 * commit. Naming it after what it is built FROM instead lets any launcher find
 * it already in the registry and skip docker entirely, which is what a launcher
 * with no docker daemon (a CI job) needs.
 *
 * What goes into the hash: the afk.Dockerfile, afk's own entrypoint (it is
 * layered in by the wrapper build), the target platform, and every local source
 * the Dockerfile COPYs or ADDs, read from the build context. .dockerignore is not
 * applied, so a source directory may hash files the build never sees — that only
 * costs a spurious rebuild, never a stale image.
 */

export { CONTENT_TAG_PREFIX }

export class UnhashableSourceError extends Error {}

/**
 * Local sources of every COPY / ADD instruction. `--from=` copies (another stage
 * or image) and remote ADD URLs are not part of the build context and are
 * skipped. A source the hash cannot pin — a glob or a build-arg expansion — is
 * refused rather than guessed at.
 */
export const copySources = (dockerfile: string): ReadonlyArray<string> =>
  dockerfile
    // Join backslash-continued lines so a wrapped COPY is seen whole.
    .replace(/\\\r?\n/g, " ")
    .split(/\r?\n/)
    .map((line) => /^(COPY|ADD)\s+((?:--\S+\s+)*)(.*)$/i.exec(line.trim()))
    .filter((m): m is RegExpExecArray => m !== null)
    .filter(([, , flags = ""]) => !/(^|\s)--from[=\s]/.test(flags))
    .flatMap(([, instruction = "", , rest = ""]) => {
      const args = rest.trim()
      const tokens: string[] = args.startsWith("[")
        ? JSON.parse(args)
        : args.split(/\s+/).filter(Boolean)
      return tokens
        .slice(0, -1)
        .filter((src) => !/^https?:\/\//.test(src))
        .map((src) => {
          if (/[*?[\]$]/.test(src)) {
            throw new UnhashableSourceError(
              `${instruction} source "${src}" is a glob or variable; a content tag cannot pin it`,
            )
          }
          return src
        })
    })

/** Every file under `path` (or `path` itself), as sorted context-relative paths. */
const filesUnder = (contextDir: string, path: string): string[] => {
  const abs = resolve(contextDir, path)
  if (!existsSync(abs)) {
    throw new UnhashableSourceError(
      `COPY/ADD source "${path}" does not exist in ${contextDir}`,
    )
  }
  if (!statSync(abs).isDirectory()) return [relative(contextDir, abs)]
  return readdirSync(abs, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => relative(contextDir, join(d.parentPath, d.name)))
    .sort()
}

export const contentTag = (opts: {
  readonly contextDir: string
  readonly dockerfile: string
  readonly entrypoint: string
  readonly platform: string
}): string => {
  const h = createHash("sha256")
  const part = (name: string, bytes: string | Buffer) => {
    h.update(`${name}\0${bytes.length}\0`)
    h.update(bytes)
  }
  part("platform", opts.platform)
  part("afk.Dockerfile", opts.dockerfile)
  part("entrypoint.sh", opts.entrypoint)
  const files = [
    ...new Set(
      copySources(opts.dockerfile).flatMap((s) =>
        filesUnder(opts.contextDir, s),
      ),
    ),
  ].sort()
  for (const f of files)
    part(`ctx/${f}`, readFileSync(resolve(opts.contextDir, f)))
  return `${CONTENT_TAG_PREFIX}${h.digest("hex").slice(0, 16)}`
}
