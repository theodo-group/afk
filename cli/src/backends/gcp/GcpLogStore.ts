import { Effect, Layer } from "effect"
import { LogStore } from "../../services/backend/LogStore.ts"
import { CloudLogging } from "../../adapters/gcp/CloudLogging.ts"
import { Auth } from "../../adapters/gcp/Auth.ts"
import { ConfigService } from "../../services/ConfigService.ts"

/**
 * GCP implementation of LogStore. Backed by Cloud Logging: the `gcplogs` driver
 * (injected per compose service) labels entries with `afk-run`/`afk-service`,
 * so a tail filters on those labels. `--all` (no `serviceFilter`) drops the
 * `afk-service` clause.
 */
export const GcpLogStoreLive = Layer.effect(
  LogStore,
  Effect.gen(function* () {
    const logging = yield* CloudLogging
    const auth = yield* Auth
    const cfg = yield* ConfigService

    return LogStore.of({
      tail: (input) =>
        Effect.gen(function* () {
          const { config } = yield* cfg.load
          const project = config.gcp?.projectId ?? (yield* auth.activeProject)
          yield* logging.tail({
            project,
            runId: input.runId,
            service: input.serviceFilter,
            follow: input.follow,
            freshness: input.since,
          })
        }),
    })
  }),
)
