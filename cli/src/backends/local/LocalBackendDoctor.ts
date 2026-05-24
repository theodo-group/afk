import { Effect, Layer } from "effect"
import { Subprocess } from "../../infra/Subprocess.ts"
import {
  BackendDoctor,
  type CheckResult,
} from "../../services/backend/BackendDoctor.ts"

/**
 * Local health checks: the only external dependency the Local Backend has is a
 * reachable Docker daemon (it runs each Run inside rootless dind on it). No
 * cloud credentials, no extra CLIs — that is the whole point of the Backend.
 */
export const LocalBackendDoctorLive = Layer.effect(
  BackendDoctor,
  Effect.gen(function* () {
    const sub = yield* Subprocess

    const checks = Effect.gen(function* () {
      const results: CheckResult[] = []

      const info = yield* sub
        .run("docker", ["info", "--format", "{{.ServerVersion}}"])
        .pipe(Effect.either)
      results.push(
        info._tag === "Right"
          ? {
              name: "docker daemon",
              ok: true,
              detail: `reachable (engine ${info.right.stdout.trim() || "unknown"})`,
            }
          : {
              name: "docker daemon",
              ok: false,
              detail: "could not reach the Docker daemon (`docker info` failed)",
            },
      )

      return results
    })

    return BackendDoctor.of({ checks })
  }),
)
