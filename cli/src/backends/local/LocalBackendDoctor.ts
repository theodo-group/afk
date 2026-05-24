import { Effect, Layer } from "effect"
import { Subprocess } from "../../infra/Subprocess.ts"
import {
  BackendDoctor,
  check,
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

    const checks = sub
      .run("docker", ["info", "--format", "{{.ServerVersion}}"])
      .pipe(
        Effect.match({
          onFailure: (): ReadonlyArray<CheckResult> => [
            check(
              "docker daemon",
              false,
              "",
              "could not reach the Docker daemon (`docker info` failed)",
            ),
          ],
          onSuccess: (info): ReadonlyArray<CheckResult> => [
            check(
              "docker daemon",
              true,
              `reachable (engine ${info.stdout.trim() || "unknown"})`,
              "",
            ),
          ],
        }),
      )

    return BackendDoctor.of({ checks })
  }),
)
