import { Effect, Layer } from "effect"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Subprocess } from "../../infra/Subprocess.ts"
import { ConfigService } from "../../services/ConfigService.ts"
import {
  BackendDoctor,
  type CheckResult,
} from "../../services/backend/BackendDoctor.ts"

// name + condition + what to say either way — collapses the repeated
// `{ name, ok, detail: ok ? … : … }` literal into one readable call.
const check = (
  name: string,
  ok: boolean,
  whenOk: string,
  whenNot: string,
): CheckResult => ({ name, ok, detail: ok ? whenOk : whenNot })

const isConfiguredWorkerUrl = (url: string | undefined): url is string =>
  typeof url === "string" && url.length > 0 && !url.startsWith("REPLACE_ME")

const workerUrlCheck = (url: string | undefined): CheckResult =>
  check(
    "cloudflare.workerUrl",
    isConfiguredWorkerUrl(url),
    url ?? "",
    "missing or still REPLACE_ME in afk.config.json",
  )

// Reached-but-bad and never-reached are both failures with a clean detail —
// no merged success/error shape to disambiguate downstream.
const probeWorkerHealth = (url: string): Effect.Effect<CheckResult> =>
  Effect.tryPromise({
    try: () => fetch(`${url.replace(/\/$/, "")}/health`),
    catch: (cause) => cause,
  }).pipe(
    Effect.map((res) =>
      check(
        "launcher Worker /health",
        res.ok,
        `HTTP ${res.status}`,
        `unreachable (HTTP ${res.status})`,
      ),
    ),
    Effect.catchAll((cause) =>
      Effect.succeed(
        check("launcher Worker /health", false, "", `unreachable (${String(cause)})`),
      ),
    ),
  )

const maybeWorkerHealth = (
  url: string | undefined,
): Effect.Effect<ReadonlyArray<CheckResult>> =>
  isConfiguredWorkerUrl(url)
    ? probeWorkerHealth(url).pipe(Effect.map((row) => [row]))
    : Effect.succeed([])

// Optional (ok stays true) so doctor doesn't fail for users who never attach —
// the detail tells them how. Attach uses `wrangler containers ssh`, which needs
// an ssh-ed25519 key baked into the deployed Worker's wrangler.toml.
const attachReadinessCheck = (projectRoot: string): CheckResult => {
  const wt = join(projectRoot, "worker", "afk", "wrangler.toml")
  const hasKey =
    existsSync(wt) &&
    /\[\[containers\.authorized_keys\]\]/.test(readFileSync(wt, "utf8"))
  return {
    name: "container SSH (attach)",
    ok: true,
    detail: hasKey
      ? "authorized_keys configured in worker/afk/wrangler.toml"
      : "optional — add [[containers.authorized_keys]] (ssh-ed25519) + redeploy to enable `afk attach`",
  }
}

export const CloudflareBackendDoctorLive = Layer.effect(
  BackendDoctor,
  Effect.gen(function* () {
    const sub = yield* Subprocess
    const cfg = yield* ConfigService

    // Each group yields ReadonlyArray<CheckResult> so the finale is one flatten.
    const wranglerChecks = sub.run("which", ["wrangler"]).pipe(
      Effect.map(() => true),
      Effect.catchAll(() => Effect.succeed(false)),
      Effect.map((ok) => [
        check(
          "wrangler",
          ok,
          "found",
          "not on PATH (required for `afk init --provider cloudflare`)",
        ),
      ]),
    )

    const apiTokenChecks = Effect.succeed([
      check(
        "CLOUDFLARE_API_TOKEN",
        (process.env.CLOUDFLARE_API_TOKEN ?? "").length > 0,
        "set",
        "unset (required for `afk init` + `afk golden build`)",
      ),
    ])

    // Config gates the rows below it: no config → one row and stop;
    // config present → workerUrl, its health (if configured), attach readiness.
    const configChecks = cfg.load.pipe(
      Effect.matchEffect({
        onFailure: () =>
          Effect.succeed<ReadonlyArray<CheckResult>>([
            check("afk.config.json", false, "", "not found — run `afk init --provider cloudflare`"),
          ]),
        onSuccess: ({ config, projectRoot }) => {
          const url = config.cloudflare?.workerUrl
          return maybeWorkerHealth(url).pipe(
            Effect.map((health) => [
              workerUrlCheck(url),
              ...health,
              attachReadinessCheck(projectRoot),
            ]),
          )
        },
      }),
    )

    const checks = Effect.all([
      wranglerChecks,
      apiTokenChecks,
      configChecks,
    ]).pipe(Effect.map((groups) => groups.flat()))

    return BackendDoctor.of({ checks })
  }),
)
