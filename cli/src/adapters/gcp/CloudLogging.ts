import { Context, Effect, Layer } from "effect"
import { Subprocess } from "../../infra/Subprocess.ts"
import { GcpError } from "../../infra/Errors.ts"
import { gcpError } from "./gcloudCli.ts"

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
 * driver (injected per compose service by `injectGcpLogging`) carries each
 * container's `afk-run` / `afk-service` labels inside the log entry's
 * `jsonPayload.container.metadata.*` (NOT at the top-level `labels.*` —
 * that's where Cloud Logging's own resource labels live), so the filter has
 * to address that path explicitly.
 *
 * Non-follow uses `gcloud logging read` once (inheriting stdout so the lines
 * land on the user's terminal). Follow polls the same `read` and dedupes by
 * `insertId` — `gcloud logging tail` is gated behind the alpha component and
 * therefore can't be assumed present on a developer's machine.
 */
export class CloudLogging extends Context.Tag("CloudLogging")<
  CloudLogging,
  {
    readonly tail: (input: TailInput) => Effect.Effect<void, GcpError>
  }
>() {}

const filterFor = (input: TailInput): string => {
  const parts = [`jsonPayload.container.metadata.afk-run="${input.runId}"`]
  if (input.service) {
    parts.push(`jsonPayload.container.metadata.afk-service="${input.service}"`)
  }
  return parts.join(" AND ")
}

// One log line per entry: timestamp \t service \t message. Matches the shape
// `aws logs tail` lands on stdout in the AWS Backend.
const LINE_FORMAT =
  "value(timestamp,jsonPayload.container.metadata.afk-service,jsonPayload.message)"

interface LogEntry {
  readonly insertId: string
  readonly timestamp: string
  readonly jsonPayload?: {
    readonly message?: string
    readonly container?: {
      readonly metadata?: { readonly ["afk-service"]?: string }
    }
  }
}

export const CloudLoggingLive = Layer.effect(
  CloudLogging,
  Effect.gen(function* () {
    const sub = yield* Subprocess

    const tail = (input: TailInput) => {
      const filter = filterFor(input)

      if (!input.follow) {
        // Non-follow: one `gcloud logging read`, stdout inherited so each
        // line lands directly on the developer's terminal. Capturing via
        // `gcloud.run` would discard the output (the original bug).
        return sub
          .stream("gcloud", [
            "logging",
            "read",
            filter,
            `--project=${input.project}`,
            "--order=asc",
            `--freshness=${input.freshness ?? "1d"}`,
            `--format=${LINE_FORMAT}`,
          ])
          .pipe(Effect.mapError(gcpError("logging:read")))
      }

      // Follow: poll `read` over a small freshness window and dedupe by
      // `insertId`. Window > interval so a slow write isn't missed; the
      // set is the only state. Interrupted on Ctrl-C via the standard
      // Effect cancellation of the surrounding fiber (Effect.sleep is
      // interruptible).
      return Effect.gen(function* () {
        const seen = new Set<string>()
        yield* Effect.forever(
          Effect.gen(function* () {
            const entries = yield* sub
              .runJson<ReadonlyArray<LogEntry>>("gcloud", [
                "logging",
                "read",
                filter,
                `--project=${input.project}`,
                "--order=asc",
                "--freshness=10s",
                "--format=json",
              ])
              .pipe(Effect.catchAll(() => Effect.succeed([])))
            for (const e of entries) {
              if (seen.has(e.insertId)) continue
              seen.add(e.insertId)
              const svc =
                e.jsonPayload?.container?.metadata?.["afk-service"] ?? ""
              const msg = e.jsonPayload?.message ?? ""
              yield* Effect.sync(() =>
                process.stdout.write(`${e.timestamp}\t${svc}\t${msg}\n`),
              )
            }
            yield* Effect.sleep("3 seconds")
          }),
        )
      }).pipe(Effect.mapError(gcpError("logging:read")))
    }

    return CloudLogging.of({ tail })
  }),
)
