import { Args, Command, Options } from "@effect/cli"
import { Effect } from "effect"
import { RunService } from "../services/RunService.ts"
import { Logs } from "../adapters/aws/Logs.ts"
import { ConfigService } from "../services/ConfigService.ts"
import { DEFAULT_REGION, LOG_GROUP_PREFIX } from "../constants.ts"

const runId = Args.text({ name: "run-id" })
const follow = Options.boolean("follow", { aliases: ["f"] })
const service = Options.text("service").pipe(
  Options.optional,
  Options.withDescription("filter to one compose service's logs"),
)
const since = Options.text("since").pipe(
  Options.withDefault("30d"),
  Options.withDescription("time window for historical reads (e.g. 1h, 24h, 7d). default 30d"),
)

export const logs = Command.make(
  "logs",
  { runId, follow, service, since },
  ({ runId, follow, service, since }) =>
    Effect.gen(function* () {
      const runs = yield* RunService
      const logsSvc = yield* Logs
      const cfg = yield* ConfigService

      yield* runs.findByRunId(runId)

      const { config, sourceRepoName } = yield* cfg.load
      const region = config.aws?.region ?? DEFAULT_REGION
      const group = `${LOG_GROUP_PREFIX}/${sourceRepoName}`

      const streamPrefix =
        service._tag === "Some"
          ? `${runId}/${service.value}`
          : `${runId}/`

      yield* logsSvc.tail({
        region,
        group,
        stream: streamPrefix,
        follow,
        since,
      })
    }),
)
