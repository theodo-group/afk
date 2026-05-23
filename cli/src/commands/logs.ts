import { Args, Command, Options } from "@effect/cli"
import { Effect } from "effect"
import { RunService } from "../services/RunService.ts"
import { LogStore } from "../services/backend/LogStore.ts"
import { ConfigService } from "../services/ConfigService.ts"

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
      // Dispatch through the active backend's LogStore (CloudWatch on AWS,
      // Workers Logs / `wrangler tail` on Cloudflare) rather than a fixed
      // provider adapter.
      const logStore = yield* LogStore
      const cfg = yield* ConfigService

      yield* runs.findByRunId(runId)

      const { sourceRepoName } = yield* cfg.load

      yield* logStore.tail({
        runId,
        repoName: sourceRepoName,
        ...(service._tag === "Some" ? { serviceFilter: service.value } : {}),
        follow,
        since,
      })
    }),
)
