import { Effect, Layer } from "effect"
import { Subprocess } from "../../infra/Subprocess.ts"
import { Auth } from "../../adapters/gcp/Auth.ts"
import {
  BackendDoctor,
  check,
  type CheckResult,
} from "../../services/backend/BackendDoctor.ts"

export const GcpBackendDoctorLive = Layer.effect(
  BackendDoctor,
  Effect.gen(function* () {
    const sub = yield* Subprocess
    const auth = yield* Auth

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

    const checks = Effect.all([toolchainChecks, identityChecks]).pipe(
      Effect.map((groups) => groups.flat()),
    )

    return BackendDoctor.of({ checks })
  }),
)
