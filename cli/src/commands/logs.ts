import { Args, Command, Options } from "@effect/cli"
import { Effect } from "effect"
import { RunService } from "../services/RunService.ts"
import { Logs } from "../adapters/aws/Logs.ts"
import { ConfigService } from "../services/ConfigService.ts"
import { LOG_GROUP_PREFIX } from "../constants.ts"

const runId = Args.text({ name: "run-id" })
const follow = Options.boolean("follow", { aliases: ["f"] })

export const logs = Command.make("logs", { runId, follow }, ({ runId, follow }) =>
  Effect.gen(function* () {
    const runs = yield* RunService
    const logsSvc = yield* Logs
    const cfg = yield* ConfigService

    const run = yield* runs.findByRunId(runId)
    const { sourceRepoName } = yield* cfg.load
    const group = `${LOG_GROUP_PREFIX}/${sourceRepoName}`
    const taskId = run.taskArn.split("/").pop() ?? run.taskArn
    const stream = `run/run/${taskId}`

    if (follow) {
      yield* logsSvc.tail({ group, stream })
      return
    }
    let token: string | undefined
    while (true) {
      const page = yield* logsSvc.getEvents({
        group,
        stream,
        startFromHead: true,
        ...(token !== undefined ? { nextToken: token } : {}),
      })
      for (const e of page.events) {
        console.log(e.message)
      }
      if (!page.nextToken || page.nextToken === token || page.events.length === 0) {
        break
      }
      token = page.nextToken
    }
  }),
)
