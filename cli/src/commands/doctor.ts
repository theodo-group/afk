import { Command } from "@effect/cli"
import { Effect } from "effect"
import { checkBinary } from "../infra/Subprocess.ts"
import { Output } from "../infra/Output.ts"
import { UserError } from "../infra/Errors.ts"
import { GoldenImageStore } from "../services/backend/GoldenImage.ts"
import {
  BackendDoctor,
  type CheckResult,
} from "../services/backend/BackendDoctor.ts"
import { Compute } from "../services/backend/Compute.ts"
import { GOLDEN_IMAGE_STALE_DAYS } from "../constants.ts"

export const doctor = Command.make("doctor", {}, () =>
  Effect.gen(function* () {
    const out = yield* Output
    const compute = yield* Compute
    const golden = yield* GoldenImageStore
    const backendDoctor = yield* BackendDoctor

    const checks: CheckResult[] = []

    // Toolchain — needed by every Backend.
    for (const bin of ["bun", "docker", "git"]) {
      const has = yield* checkBinary(bin)
      checks.push({ name: bin, ok: has, detail: has ? "found" : "not on PATH" })
    }

    // Backend-specific checks (binaries, credentials, endpoints) via the seam.
    checks.push(...(yield* backendDoctor.checks))

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
