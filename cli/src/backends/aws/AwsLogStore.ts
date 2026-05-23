import { Effect, Layer } from "effect"
import { LogStore } from "../../services/backend/LogStore.ts"
import { Logs } from "../../adapters/aws/Logs.ts"
import { ConfigService } from "../../services/ConfigService.ts"
import { DEFAULT_REGION, LOG_GROUP_PREFIX } from "../../constants.ts"

/**
 * AWS implementation of LogStore. Backed by CloudWatch Logs via `aws logs tail`.
 * Streams are named `<runId>/<service>` and live under `/afk/<repo>`.
 */
export const AwsLogStoreLive = Layer.effect(
  LogStore,
  Effect.gen(function* () {
    const logs = yield* Logs
    const cfg = yield* ConfigService

    return LogStore.of({
      tail: (input) =>
        Effect.gen(function* () {
          const { config } = yield* cfg.load
          const region = config.aws?.region ?? DEFAULT_REGION
          const group = `${LOG_GROUP_PREFIX}/${input.repoName}`
          const streamPrefix = input.serviceFilter
            ? `${input.runId}/${input.serviceFilter}`
            : `${input.runId}/`
          yield* logs.tail({
            region,
            group,
            stream: streamPrefix,
            follow: input.follow,
            since: input.since,
          })
        }),
    })
  }),
)
