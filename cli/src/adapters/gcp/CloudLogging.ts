import { Context, Effect, Layer } from "effect"
import { Subprocess } from "../../infra/Subprocess.ts"
import { GcpError } from "../../infra/Errors.ts"
import { gcpError, makeGcloudCli } from "./gcloudCli.ts"

export interface TailInput {
  readonly project: string
  readonly runId: string
  /** When set, only this compose service's logs; otherwise every service. */
  readonly service?: string
  readonly follow: boolean
  /** Freshness window for the non-follow read, e.g. "30d" / "1h". */
  readonly freshness?: string
}

/**
 * Cloud Logging adapter — the GCP analogue of `Logs`. The Docker `gcplogs`
 * driver (injected per compose service by `injectGcpLogging`) labels every log
 * entry with `afk-run` and `afk-service`, so a read filters on those labels.
 * `gcloud logging tail` streams live (follow); `gcloud logging read` paginates
 * the recent window otherwise.
 */
export class CloudLogging extends Context.Tag("CloudLogging")<
  CloudLogging,
  {
    readonly tail: (input: TailInput) => Effect.Effect<void, GcpError>
  }
>() {}

const filterFor = (input: TailInput): string => {
  const parts = [`labels.afk-run="${input.runId}"`]
  if (input.service) parts.push(`labels.afk-service="${input.service}"`)
  return parts.join(" AND ")
}

export const CloudLoggingLive = Layer.effect(
  CloudLogging,
  Effect.gen(function* () {
    const sub = yield* Subprocess
    const gcloud = makeGcloudCli(sub)

    const tail = (input: TailInput) => {
      const filter = filterFor(input)
      if (input.follow) {
        // `logging tail` is a long-lived follow — killed on interruption.
        return sub
          .stream("gcloud", [
            "logging",
            "tail",
            filter,
            `--project=${input.project}`,
          ])
          .pipe(Effect.mapError(gcpError("logging:tail")))
      }
      return gcloud.run("logging:read", [
        "logging",
        "read",
        filter,
        `--project=${input.project}`,
        "--order=asc",
        `--freshness=${input.freshness ?? "1d"}`,
      ])
    }

    return CloudLogging.of({ tail })
  }),
)
