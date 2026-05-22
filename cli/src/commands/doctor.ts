import { Command } from "@effect/cli"
import { Effect } from "effect"
import { Subprocess, checkBinary } from "../infra/Subprocess.ts"
import { Sts } from "../adapters/aws/Sts.ts"
import { Output } from "../infra/Output.ts"
import { UserError } from "../infra/Errors.ts"
import { ImageService } from "../services/ImageService.ts"
import { ConfigService } from "../services/ConfigService.ts"
import { DEFAULT_REGION, GOLDEN_IMAGE_STALE_DAYS } from "../constants.ts"

interface CheckResult {
  readonly name: string
  readonly ok: boolean
  readonly detail: string
}

export const doctor = Command.make("doctor", {}, () =>
  Effect.gen(function* () {
    const sub = yield* Subprocess
    const out = yield* Output
    const sts = yield* Sts
    const images = yield* ImageService
    const cfg = yield* ConfigService

    const checks: CheckResult[] = []

    for (const bin of ["bun", "docker", "terraform", "aws", "git"]) {
      const has = yield* checkBinary(bin)
      checks.push({
        name: bin,
        ok: has,
        detail: has ? "found" : "not on PATH",
      })
    }

    const ssmPluginPath = yield* sub
      .run("which", ["session-manager-plugin"])
      .pipe(
        Effect.map((r) => r.stdout.trim()),
        Effect.catchAll(() => Effect.succeed("")),
      )
    checks.push({
      name: "session-manager-plugin",
      ok: ssmPluginPath.length > 0,
      detail:
        ssmPluginPath.length > 0
          ? "found"
          : "not on PATH (required for `afk attach`)",
    })

    const identity = yield* sts.callerIdentity.pipe(Effect.either)
    checks.push(
      identity._tag === "Right"
        ? {
            name: "aws credentials",
            ok: true,
            detail: `${identity.right.Arn} (account ${identity.right.Account})`,
          }
        : {
            name: "aws credentials",
            ok: false,
            detail: "could not call sts:GetCallerIdentity",
          },
    )

    // Golden image presence + age (only if we have a config + creds).
    const loaded = yield* cfg.load.pipe(Effect.either)
    if (loaded._tag === "Right" && identity._tag === "Right") {
      const region = loaded.right.config.aws?.region ?? DEFAULT_REGION
      const golden = yield* images.findLatestGolden(region).pipe(Effect.either)
      if (golden._tag === "Right" && golden.right) {
        const g = golden.right
        const ageDays = g.builtAt
          ? Math.floor((Date.now() - Date.parse(g.builtAt)) / (24 * 3600 * 1000))
          : -1
        const stale = ageDays >= 0 && ageDays > GOLDEN_IMAGE_STALE_DAYS
        checks.push({
          name: "golden image",
          ok: true,
          detail: stale
            ? `${g.imageId} (${ageDays}d old — consider \`afk image build\`)`
            : `${g.imageId} (${ageDays >= 0 ? `${ageDays}d` : "unknown age"})`,
        })
      } else if (golden._tag === "Right") {
        checks.push({
          name: "golden image",
          ok: false,
          detail: `none found in ${region} — run \`afk image build\``,
        })
      } else {
        checks.push({
          name: "golden image",
          ok: false,
          detail: `could not query EC2: ${golden.left.message}`,
        })
      }
    }

    yield* out.emit({
      data: { checks, ok: checks.every((c) => c.ok) },
      human: () =>
        out.printTable(checks, [
          { header: "CHECK", value: (c) => c.name },
          { header: "STATUS", value: (c) => (c.ok ? "ok" : "FAIL") },
          { header: "DETAIL", value: (c) => c.detail },
        ]),
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
