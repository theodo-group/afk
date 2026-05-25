import { Effect, Layer } from "effect"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { resolve } from "node:path"
import { Subprocess } from "../../infra/Subprocess.ts"
import { Auth } from "../../adapters/gcp/Auth.ts"
import { ConfigService } from "../../services/ConfigService.ts"
import {
  BackendDoctor,
  check,
  type CheckResult,
} from "../../services/backend/BackendDoctor.ts"

/**
 * Read quota_project_id from the developer's Application Default Credentials.
 * Returns null when the ADC file is missing / unparseable / has no quota
 * project — we only flag the case where ADC carries a value that doesn't
 * match the project afk.config.json points at, since that's the failure mode
 * that surfaces as a 403 inside `terraform apply` and reads like a billing
 * problem.
 */
const readAdcQuotaProject = (): string | null => {
  const candidates = [
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
    resolve(
      homedir(),
      ".config",
      "gcloud",
      "application_default_credentials.json",
    ),
  ].filter((p): p is string => typeof p === "string" && p.length > 0)
  for (const path of candidates) {
    if (!existsSync(path)) continue
    try {
      const adc = JSON.parse(readFileSync(path, "utf8")) as {
        quota_project_id?: unknown
      }
      if (typeof adc.quota_project_id === "string") return adc.quota_project_id
    } catch {
      // Unparseable ADC isn't a doctor-recoverable condition.
    }
  }
  return null
}

export const GcpBackendDoctorLive = Layer.effect(
  BackendDoctor,
  Effect.gen(function* () {
    const sub = yield* Subprocess
    const auth = yield* Auth
    const cfg = yield* ConfigService

    const binaryCheck = (bin: string, whenNot: string) =>
      sub.run("which", [bin]).pipe(
        Effect.map(() => true),
        Effect.catchAll(() => Effect.succeed(false)),
        Effect.map((ok) => check(bin, ok, "found", whenNot)),
      )

    const toolchainChecks = Effect.all([
      binaryCheck("terraform", "not on PATH"),
      binaryCheck("gcloud", "not on PATH"),
      binaryCheck("curl", "not on PATH (required for Firestore history)"),
    ])

    const identityChecks = Effect.all([
      auth.callerAccount.pipe(
        Effect.match({
          onFailure: (): CheckResult =>
            check("gcloud account", false, "", "no active gcloud account"),
          onSuccess: (account): CheckResult =>
            check("gcloud account", true, account, ""),
        }),
      ),
      auth.activeProject.pipe(
        Effect.match({
          onFailure: (): CheckResult =>
            check("gcloud project", false, "", "no active project set"),
          onSuccess: (project): CheckResult =>
            check("gcloud project", true, project, ""),
        }),
      ),
    ])

    const adcCheck = Effect.gen(function* () {
      const { config } = yield* cfg.load
      const expected = config.gcp?.projectId
      const adcQuotaProject = readAdcQuotaProject()
      if (expected === undefined || expected === "") {
        return check(
          "adc quota project",
          true,
          "(skipped — gcp.projectId not set in afk.config.json)",
          "",
        )
      }
      if (adcQuotaProject === null) {
        return check(
          "adc quota project",
          true,
          "(no quota_project_id in ADC; will default)",
          "",
        )
      }
      if (adcQuotaProject === expected) {
        return check("adc quota project", true, adcQuotaProject, "")
      }
      return check(
        "adc quota project",
        false,
        "",
        `ADC quota_project_id (${adcQuotaProject}) != gcp.projectId (${expected}); run: gcloud auth application-default set-quota-project ${expected}`,
      )
    }).pipe(
      Effect.catchAll((e) =>
        Effect.succeed(
          check(
            "adc quota project",
            false,
            "",
            `could not load afk.config.json: ${e.message}`,
          ),
        ),
      ),
    )

    const checks = Effect.all([toolchainChecks, identityChecks, adcCheck]).pipe(
      Effect.map(([toolchain, identity, adc]) => [...toolchain, ...identity, adc]),
    )

    return BackendDoctor.of({ checks })
  }),
)
