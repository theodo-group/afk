import { Effect, Layer } from "effect"
import { LogStore } from "../../services/backend/LogStore.ts"
import { Logs, type LogEvent } from "../../adapters/aws/Logs.ts"
import { ConfigService } from "../../services/ConfigService.ts"
import { Output } from "../../infra/Output.ts"
import { type AwsError, UserError } from "../../infra/Errors.ts"
import {
  DEFAULT_LOG_SINCE,
  DEFAULT_REGION,
  logGroupPrefix,
} from "../../constants.ts"

const DURATION = /^(\d+)([smhdw])$/
const UNIT_MS = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
} as const

/**
 * `--since` as epoch ms: a duration back from `nowMs` ("30d", "1h") or an
 * absolute ISO timestamp, the two forms `aws logs tail --since` accepts.
 */
export const startTimeMs = (
  since: string,
  nowMs: number,
): number | undefined => {
  const duration = DURATION.exec(since)
  if (duration) {
    const unit = duration[2] as keyof typeof UNIT_MS
    return nowMs - Number(duration[1]) * UNIT_MS[unit]
  }
  const absolute = Date.parse(since)
  return Number.isNaN(absolute) ? undefined : absolute
}

export interface StreamEvent extends LogEvent {
  readonly stream: string
}

/**
 * Same `<timestamp> <stream> <message>` lines `aws logs tail` prints, so a
 * reader parsing one (the console) parses the other.
 */
export const formatEvents = (events: ReadonlyArray<StreamEvent>): string =>
  [...events]
    .sort((a, b) => a.timestamp - b.timestamp)
    .map(
      (e) =>
        `${new Date(e.timestamp).toISOString().replace("Z", "000+00:00")} ${e.stream} ${e.message}`,
    )
    .join("\n")

/**
 * AWS implementation of LogStore, over CloudWatch Logs. Streams are named
 * `<runId>/<service>` and live under `/afk/<repo>`.
 *
 * A one-shot read goes to the Run's own streams (DescribeLogStreams +
 * GetLogEvents), not `aws logs tail`: tail is FilterLogEvents over the whole
 * group, scanning every Run's streams for the window — measured at ~6 min on a
 * 660-stream group, against ~1 s here. `--follow` still needs tail, the only
 * call that streams new events; it starts at the Run's start, not a default
 * window.
 */
export const AwsLogStoreLive = Layer.effect(
  LogStore,
  Effect.gen(function* () {
    const logs = yield* Logs
    const cfg = yield* ConfigService
    const out = yield* Output

    return LogStore.of({
      tail: (input) =>
        Effect.gen(function* () {
          const { config } = yield* cfg.load
          const region = config.aws?.region ?? DEFAULT_REGION
          const group = `${logGroupPrefix(config.aws?.resourcePrefix)}/${input.repoName}`
          const streamPrefix = input.serviceFilter
            ? `${input.runId}/${input.serviceFilter}`
            : `${input.runId}/`
          const since = input.since ?? input.startedAt ?? DEFAULT_LOG_SINCE

          if (input.follow) {
            return yield* logs.tail({
              region,
              group,
              stream: streamPrefix,
              follow: true,
              since,
            })
          }

          const startTime = startTimeMs(since, Date.now())
          if (startTime === undefined) {
            return yield* Effect.fail(
              new UserError({
                message: `Cannot read --since '${since}'.`,
                hint: "Use a duration (30d, 1h, 10m) or an ISO timestamp.",
              }),
            )
          }

          // GetLogEvents marks the end of a stream by handing back the token
          // it was given.
          const readStream = (
            stream: string,
            token?: string,
            read: ReadonlyArray<StreamEvent> = [],
          ): Effect.Effect<ReadonlyArray<StreamEvent>, AwsError> =>
            logs
              .getEvents({
                region,
                group,
                stream,
                startFromHead: true,
                startTime,
                ...(token !== undefined ? { nextToken: token } : {}),
              })
              .pipe(
                Effect.flatMap((page) => {
                  const all = [
                    ...read,
                    ...page.events.map((e) => ({ ...e, stream })),
                  ]
                  return page.nextToken === undefined ||
                    page.nextToken === token
                    ? Effect.succeed(all)
                    : readStream(stream, page.nextToken, all)
                }),
              )

          const events = yield* logs
            .streamNames({ region, group, prefix: streamPrefix })
            .pipe(
              Effect.flatMap((streams) =>
                Effect.forEach(streams, (s) => readStream(s), {
                  concurrency: 4,
                }),
              ),
              Effect.map((perStream) => perStream.flat()),
            )
          if (events.length) yield* out.print(formatEvents(events))
        }),
    })
  }),
)
