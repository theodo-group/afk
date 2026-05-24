import { Effect, Layer } from "effect"
import { Subprocess } from "../../infra/Subprocess.ts"
import { Sts } from "../../adapters/aws/Sts.ts"
import {
  BackendDoctor,
  check,
  type CheckResult,
} from "../../services/backend/BackendDoctor.ts"

export const AwsBackendDoctorLive = Layer.effect(
  BackendDoctor,
  Effect.gen(function* () {
    const sub = yield* Subprocess
    const sts = yield* Sts

    const binaryCheck = (bin: string, whenNot: string) =>
      sub.run("which", [bin]).pipe(
        Effect.map(() => true),
        Effect.catchAll(() => Effect.succeed(false)),
        Effect.map((ok) => check(bin, ok, "found", whenNot)),
      )

    const toolchainChecks = Effect.all([
      binaryCheck("terraform", "not on PATH"),
      binaryCheck("aws", "not on PATH"),
      binaryCheck(
        "session-manager-plugin",
        "not on PATH (required for `afk attach`)",
      ),
    ])

    const credentialsChecks = sts.callerIdentity.pipe(
      Effect.match({
        onFailure: (): ReadonlyArray<CheckResult> => [
          check(
            "aws credentials",
            false,
            "",
            "could not call sts:GetCallerIdentity",
          ),
        ],
        onSuccess: (id): ReadonlyArray<CheckResult> => [
          check(
            "aws credentials",
            true,
            `${id.Arn} (account ${id.Account})`,
            "",
          ),
        ],
      }),
    )

    const checks = Effect.all([toolchainChecks, credentialsChecks]).pipe(
      Effect.map((groups) => groups.flat()),
    )

    return BackendDoctor.of({ checks })
  }),
)
