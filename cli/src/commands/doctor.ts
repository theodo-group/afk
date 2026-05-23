import { Command } from "@effect/cli"
import { Effect } from "effect"
import { Subprocess, checkBinary } from "../infra/Subprocess.ts"
import { Sts } from "../adapters/aws/Sts.ts"
import { Output } from "../infra/Output.ts"
import { UserError } from "../infra/Errors.ts"
import { ImageService } from "../services/ImageService.ts"
import { CloudflareGoldenBuilder } from "../services/CloudflareGoldenBuilder.ts"
import { ConfigService } from "../services/ConfigService.ts"
import { Compute } from "../services/backend/Compute.ts"
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
    const compute = yield* Compute
    const cfg = yield* ConfigService

    const checks: CheckResult[] = []

    // ---------------- Common binaries (every Backend needs these) -----------
    for (const bin of ["bun", "docker", "git"]) {
      const has = yield* checkBinary(bin)
      checks.push({
        name: bin,
        ok: has,
        detail: has ? "found" : "not on PATH",
      })
    }

    // ---------------- Backend-specific dispatch -----------------------------
    if (compute.backendName === "cloudflare") {
      // wrangler binary
      const hasWrangler = yield* checkBinary("wrangler")
      checks.push({
        name: "wrangler",
        ok: hasWrangler,
        detail: hasWrangler ? "found" : "not on PATH (required for `afk init --provider cloudflare`)",
      })

      // CLOUDFLARE_API_TOKEN env var
      const tokenSet = (process.env.CLOUDFLARE_API_TOKEN ?? "").length > 0
      checks.push({
        name: "CLOUDFLARE_API_TOKEN",
        ok: tokenSet,
        detail: tokenSet ? "set" : "unset (required for `afk init` + `afk golden build`)",
      })

      // Config + workerUrl
      const loaded = yield* cfg.load.pipe(Effect.either)
      let workerUrl: string | undefined
      if (loaded._tag === "Right") {
        workerUrl = loaded.right.config.cloudflare?.workerUrl
        const configured =
          typeof workerUrl === "string" && workerUrl.length > 0 && !workerUrl.startsWith("REPLACE_ME")
        checks.push({
          name: "cloudflare.workerUrl",
          ok: configured,
          detail: configured ? workerUrl! : "missing or still REPLACE_ME in afk.config.json",
        })

        // Reachability: HEAD /health on the launcher Worker
        if (configured) {
          const health = yield* Effect.tryPromise({
            try: () => fetch(`${workerUrl!.replace(/\/$/, "")}/health`, { method: "GET" }),
            catch: (e) => new Error(String(e)),
          }).pipe(
            Effect.map((r) => ({ ok: r.ok, status: r.status })),
            Effect.catchAll((e) => Effect.succeed({ ok: false, status: 0, error: (e as Error).message })),
          )
          checks.push({
            name: "launcher Worker /health",
            ok: health.ok,
            detail: health.ok
              ? `HTTP ${health.status}`
              : `unreachable${"error" in health ? ` (${health.error})` : ` (HTTP ${health.status})`}`,
          })
        }

        // Golden Container image
        const golden = yield* (yield* CloudflareGoldenBuilder).findLatest.pipe(Effect.either)
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
              ? `${g.imageUri} (${ageDays}d old — consider \`afk golden build\`)`
              : `${g.imageUri} (${ageDays >= 0 ? `${ageDays}d` : "unknown age"})`,
          })
        } else if (golden._tag === "Right") {
          checks.push({
            name: "golden image",
            ok: false,
            detail: "none found — run `afk golden build` (note: CF registry listing is partially stubbed; see IMPROVEMENTS.md #9)",
          })
        } else {
          checks.push({
            name: "golden image",
            ok: false,
            detail: `could not query CF registry: ${golden.left.message}`,
          })
        }
      } else {
        checks.push({
          name: "afk.config.json",
          ok: false,
          detail: "not found — run `afk init --provider cloudflare`",
        })
      }
    } else {
      // AWS path (unchanged)
      const sts = yield* Sts
      const images = yield* ImageService

      for (const bin of ["terraform", "aws"]) {
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
              ? `${g.imageId} (${ageDays}d old — consider \`afk golden build\`)`
              : `${g.imageId} (${ageDays >= 0 ? `${ageDays}d` : "unknown age"})`,
          })
        } else if (golden._tag === "Right") {
          checks.push({
            name: "golden image",
            ok: false,
            detail: `none found in ${region} — run \`afk golden build\``,
          })
        } else {
          checks.push({
            name: "golden image",
            ok: false,
            detail: `could not query EC2: ${golden.left.message}`,
          })
        }
      }
    }

    yield* out.emit({
      data: { backend: compute.backendName, checks, ok: checks.every((c) => c.ok) },
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
