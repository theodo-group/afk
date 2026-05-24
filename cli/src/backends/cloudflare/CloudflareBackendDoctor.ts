import { Effect, Layer } from "effect"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Subprocess } from "../../infra/Subprocess.ts"
import { ConfigService } from "../../services/ConfigService.ts"
import {
  BackendDoctor,
  type CheckResult,
} from "../../services/backend/BackendDoctor.ts"

export const CloudflareBackendDoctorLive = Layer.effect(
  BackendDoctor,
  Effect.gen(function* () {
    const sub = yield* Subprocess
    const cfg = yield* ConfigService

    const hasBinary = (bin: string) =>
      sub.run("which", [bin]).pipe(
        Effect.map(() => true),
        Effect.catchAll(() => Effect.succeed(false)),
      )

    const checks = Effect.gen(function* () {
      const results: CheckResult[] = []

      const wrangler = yield* hasBinary("wrangler")
      results.push({
        name: "wrangler",
        ok: wrangler,
        detail: wrangler
          ? "found"
          : "not on PATH (required for `afk init --provider cloudflare`)",
      })

      const tokenSet = (process.env.CLOUDFLARE_API_TOKEN ?? "").length > 0
      results.push({
        name: "CLOUDFLARE_API_TOKEN",
        ok: tokenSet,
        detail: tokenSet
          ? "set"
          : "unset (required for `afk init` + `afk golden build`)",
      })

      const loaded = yield* cfg.load.pipe(Effect.either)
      if (loaded._tag !== "Right") {
        results.push({
          name: "afk.config.json",
          ok: false,
          detail: "not found — run `afk init --provider cloudflare`",
        })
        return results
      }

      const workerUrl = loaded.right.config.cloudflare?.workerUrl
      const configured =
        typeof workerUrl === "string" &&
        workerUrl.length > 0 &&
        !workerUrl.startsWith("REPLACE_ME")
      results.push({
        name: "cloudflare.workerUrl",
        ok: configured,
        detail: configured ? workerUrl! : "missing or still REPLACE_ME in afk.config.json",
      })

      if (configured) {
        const health = yield* Effect.tryPromise({
          try: () => fetch(`${workerUrl!.replace(/\/$/, "")}/health`, { method: "GET" }),
          catch: (e) => new Error(String(e)),
        }).pipe(
          Effect.map((r) => ({ ok: r.ok, status: r.status })),
          Effect.catchAll((e) =>
            Effect.succeed({ ok: false, status: 0, error: (e as Error).message }),
          ),
        )
        results.push({
          name: "launcher Worker /health",
          ok: health.ok,
          detail: health.ok
            ? `HTTP ${health.status}`
            : `unreachable${"error" in health ? ` (${health.error})` : ` (HTTP ${health.status})`}`,
        })
      }

      // SSH readiness for `afk attach`. Optional (ok stays true) so doctor
      // doesn't fail for users who never attach — the detail tells them how to
      // enable it. Attach uses `wrangler containers ssh`, which requires an
      // ssh-ed25519 key baked into the deployed Worker's wrangler.toml.
      const wt = join(loaded.right.projectRoot, "worker", "afk", "wrangler.toml")
      const hasKey =
        existsSync(wt) && /\[\[containers\.authorized_keys\]\]/.test(readFileSync(wt, "utf8"))
      results.push({
        name: "container SSH (attach)",
        ok: true,
        detail: hasKey
          ? "authorized_keys configured in worker/afk/wrangler.toml"
          : "optional — add [[containers.authorized_keys]] (ssh-ed25519) + redeploy to enable `afk attach`",
      })

      return results
    })

    return BackendDoctor.of({ checks })
  }),
)
