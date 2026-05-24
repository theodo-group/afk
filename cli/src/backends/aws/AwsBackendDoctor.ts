import { Effect, Layer } from "effect"
import { Subprocess } from "../../infra/Subprocess.ts"
import { Sts } from "../../adapters/aws/Sts.ts"
import {
  BackendDoctor,
  type CheckResult,
} from "../../services/backend/BackendDoctor.ts"

export const AwsBackendDoctorLive = Layer.effect(
  BackendDoctor,
  Effect.gen(function* () {
    const sub = yield* Subprocess
    const sts = yield* Sts

    const hasBinary = (bin: string) =>
      sub.run("which", [bin]).pipe(
        Effect.map(() => true),
        Effect.catchAll(() => Effect.succeed(false)),
      )

    const checks = Effect.gen(function* () {
      const results: CheckResult[] = []

      for (const bin of ["terraform", "aws"]) {
        const has = yield* hasBinary(bin)
        results.push({ name: bin, ok: has, detail: has ? "found" : "not on PATH" })
      }

      const ssmPlugin = yield* hasBinary("session-manager-plugin")
      results.push({
        name: "session-manager-plugin",
        ok: ssmPlugin,
        detail: ssmPlugin ? "found" : "not on PATH (required for `afk attach`)",
      })

      const identity = yield* sts.callerIdentity.pipe(Effect.either)
      results.push(
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

      return results
    })

    return BackendDoctor.of({ checks })
  }),
)
