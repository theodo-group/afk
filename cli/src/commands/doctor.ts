import { Command } from "@effect/cli"
import { Effect } from "effect"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { checkBinary } from "../infra/Subprocess.ts"
import { Output } from "../infra/Output.ts"
import { UserError } from "../infra/Errors.ts"
import { ConfigService } from "../services/ConfigService.ts"
import { SecretStore } from "../services/backend/SecretStore.ts"
import { GoldenImageStore } from "../services/backend/GoldenImage.ts"
import {
  BackendDoctor,
  check,
  type CheckResult,
} from "../services/backend/BackendDoctor.ts"
import { Compute } from "../services/backend/Compute.ts"
import { DOCKERFILE, ENV_FILE, GOLDEN_IMAGE_STALE_DAYS } from "../constants.ts"

/**
 * Light syntactic check on the consumer's afk.Dockerfile: contracts only —
 * file exists, has a FROM, doesn't declare ENTRYPOINT (the CLI injects one),
 * doesn't COPY source code (the entrypoint clones into /workspace at Run
 * start). Catches the three contract violations new consumers most often hit;
 * doesn't try to validate the Dockerfile syntactically (that's `docker build`).
 */
const checkDockerfile = (projectRoot: string): CheckResult => {
  const path = resolve(projectRoot, DOCKERFILE)
  if (!existsSync(path)) {
    return check(DOCKERFILE, false, "", `missing — expected at ${path}`)
  }
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
  const hasFrom = lines.some((l) => /^FROM\b/i.test(l))
  const hasEntrypoint = lines.some((l) => /^ENTRYPOINT\b/i.test(l))
  const copiesWorkspace = lines.some(
    (l) => /^COPY\b\s+\.\s+/i.test(l) || /^COPY\b.*\s\/workspace\b/i.test(l),
  )
  if (!hasFrom) {
    return check(DOCKERFILE, false, "", "no FROM line found")
  }
  if (hasEntrypoint) {
    return check(
      DOCKERFILE,
      false,
      "",
      "declares ENTRYPOINT — afk injects one; remove it",
    )
  }
  if (copiesWorkspace) {
    return check(
      DOCKERFILE,
      false,
      "",
      "COPY-s source into the image — afk clones at Run start; remove the COPY",
    )
  }
  return check(DOCKERFILE, true, "contract checks pass", "")
}

/**
 * Parse .afk.env and pull out the names referenced as `<KEY>=secret:<name>`.
 * Same shape the Backend resolves at Run boot — checked against the live
 * SecretStore.list() so the developer learns about a missing entry at
 * `afk doctor` time, not at the start of a Run (where it'd fail the boot).
 */
const extractSecretRefs = (projectRoot: string): ReadonlyArray<string> => {
  const path = resolve(projectRoot, ENV_FILE)
  if (!existsSync(path)) return []
  const refs: string[] = []
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.replace(/#.*$/, "").trim()
    const m = line.match(/^[A-Z_][A-Z0-9_]*=secret:([A-Za-z0-9._-]+)$/i)
    if (m && m[1]) refs.push(m[1])
  }
  return refs
}

export const doctor = Command.make("doctor", {}, () =>
  Effect.gen(function* () {
    const out = yield* Output
    const compute = yield* Compute
    const golden = yield* GoldenImageStore
    const backendDoctor = yield* BackendDoctor
    const cfg = yield* ConfigService
    const secrets = yield* SecretStore

    const checks: CheckResult[] = []

    // Toolchain — needed by every Backend.
    for (const bin of ["bun", "docker", "git"]) {
      const has = yield* checkBinary(bin)
      checks.push({ name: bin, ok: has, detail: has ? "found" : "not on PATH" })
    }

    // Backend-specific checks (binaries, credentials, endpoints) via the seam.
    checks.push(...(yield* backendDoctor.checks))

    // Consumer-contract checks against the working tree.
    const loaded = yield* cfg.load.pipe(Effect.either)
    if (loaded._tag === "Right") {
      const { projectRoot } = loaded.right
      checks.push(checkDockerfile(projectRoot))

      // Every `secret:<name>` reference in .afk.env must already live in the
      // active store; a missing one fails the Run at boot, not at submit time.
      // List once and intersect — one round-trip regardless of reference count.
      const refs = extractSecretRefs(projectRoot)
      if (refs.length > 0) {
        const stored = yield* secrets.list.pipe(Effect.either)
        if (stored._tag === "Right") {
          const have = new Set(stored.right.map((s) => s.name))
          const missing = refs.filter((r) => !have.has(r))
          checks.push({
            name: "secret references",
            ok: missing.length === 0,
            detail:
              missing.length === 0
                ? `${refs.length} reference${refs.length === 1 ? "" : "s"} resolve`
                : `${missing.length} unresolved: ${missing.join(", ")} — \`afk secrets put <name>\``,
          })
        } else {
          checks.push({
            name: "secret references",
            ok: false,
            detail: `could not list stored secrets: ${stored.left.message}`,
          })
        }
      }
    } else {
      checks.push({
        name: "afk.config.json",
        ok: false,
        detail: `could not load: ${loaded.left.message}`,
      })
    }

    // Golden Image freshness — backend-neutral via the GoldenImageStore seam.
    const latest = yield* golden.findLatest.pipe(Effect.either)
    if (latest._tag === "Right" && latest.right) {
      const g = latest.right
      const ageDays = g.builtAt
        ? Math.floor((Date.now() - Date.parse(g.builtAt)) / (24 * 3600 * 1000))
        : -1
      const stale = ageDays >= 0 && ageDays > GOLDEN_IMAGE_STALE_DAYS
      checks.push({
        name: "golden image",
        ok: true,
        detail: stale
          ? `${g.id} (${ageDays}d old — consider \`afk golden build\`)`
          : `${g.id} (${ageDays >= 0 ? `${ageDays}d` : "unknown age"})`,
      })
    } else if (latest._tag === "Right") {
      checks.push({
        name: "golden image",
        ok: false,
        detail: "none found — run `afk golden build`",
      })
    } else {
      checks.push({
        name: "golden image",
        ok: false,
        detail: `could not query Golden Image store: ${latest.left.message}`,
      })
    }

    yield* out.emit({
      data: {
        backend: compute.backendName,
        checks,
        ok: checks.every((c) => c.ok),
      },
      human: () =>
        Effect.gen(function* () {
          yield* out.print(`backend: ${compute.backendName}`)
          yield* out.printTable(checks, [
            { header: "CHECK", value: (c) => c.name },
            { header: "STATUS", value: (c) => (c.ok ? "ok" : "FAIL") },
            { header: "DETAIL", value: (c) => c.detail },
          ])
        }),
    })

    if (checks.some((c) => !c.ok)) {
      return yield* Effect.fail(
        new UserError({
          message: "doctor: one or more checks failed",
        }),
      )
    }
  }),
)
