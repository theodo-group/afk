import { Effect } from "effect"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { UserError } from "../infra/Errors.ts"

/**
 * `backend.tf` bakes the S3 backend's region at `afk init` time, but
 * `afk.config.json`'s region can drift from it afterward (e.g. re-running
 * `afk init` without `--region` rewrites backend.tf to the default while the
 * config keeps an edited value). Terraform then aborts init with an opaque
 * "Backend configuration changed". Pure core: the shell supplies the file
 * contents and the config region.
 */
export const detectBackendRegionDrift = (input: {
  readonly backendTf: string
  readonly configRegion: string
}): {
  readonly bakedRegion: string | undefined
  readonly drifted: boolean
} => {
  const bakedRegion = input.backendTf.match(/region\s*=\s*"([^"]+)"/)?.[1]
  return {
    bakedRegion,
    drifted: bakedRegion !== undefined && bakedRegion !== input.configRegion,
  }
}

/**
 * Fail early — with an actionable hint — when `terraform/afk/backend.tf` was
 * rendered for a different region than `afk.config.json` now declares, so the
 * developer never sees terraform's cryptic backend error. No-op when the
 * module hasn't been initialised yet.
 */
export const ensureBackendRegionMatches = (input: {
  readonly terraformDir: string
  readonly configRegion: string
}): Effect.Effect<void, UserError> =>
  Effect.gen(function* () {
    const backendPath = resolve(input.terraformDir, "backend.tf")
    if (!existsSync(backendPath)) return
    const backendTf = yield* Effect.try({
      try: () => readFileSync(backendPath, "utf8"),
      catch: (cause) =>
        new UserError({
          message: `failed to read backend.tf: ${String(cause)}`,
        }),
    })
    const { bakedRegion, drifted } = detectBackendRegionDrift({
      backendTf,
      configRegion: input.configRegion,
    })
    if (drifted) {
      return yield* Effect.fail(
        new UserError({
          message: `terraform backend region (${bakedRegion}) does not match afk.config.json region (${input.configRegion}).`,
          hint: `${backendPath} was rendered for ${bakedRegion}. Re-run \`afk init --provider aws --region ${input.configRegion}\` to re-render the backend and ensure its state bucket exists.`,
        }),
      )
    }
  })
