import { Args, Command, Options } from "@effect/cli"
import { Effect } from "effect"
import { RunService } from "../services/RunService.ts"

const runId = Args.text({ name: "run-id" })
const service = Options.text("service").pipe(
  Options.optional,
  Options.withDescription("attach to a specific compose service (default: main service)"),
)
const host = Options.boolean("host").pipe(
  Options.withDescription("drop to the VM's host shell instead of `docker exec` into the container"),
)

export const attach = Command.make(
  "attach",
  { runId, service, host },
  ({ runId, service, host }) =>
    Effect.gen(function* () {
      const runs = yield* RunService
      yield* runs.attach(runId, {
        service: service._tag === "Some" ? service.value : undefined,
        host,
      })
    }),
)
