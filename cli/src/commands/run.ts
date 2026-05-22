import { Args, Command, Options } from "@effect/cli"
import { Effect } from "effect"
import { RunService } from "../services/RunService.ts"
import { Output } from "../infra/Output.ts"

const ref = Options.text("ref").pipe(Options.optional)
const instanceType = Options.text("instance-type").pipe(Options.optional)
const onDemand = Options.boolean("on-demand").pipe(
  Options.withDescription("disable Spot (Runs use Spot by default)"),
)
const timeout = Options.integer("timeout").pipe(
  Options.optional,
  Options.withDescription("wall-clock cap in hours"),
)
const detach = Options.boolean("detach", { aliases: ["d"] }).pipe(
  Options.withDescription("return immediately after launch instead of streaming logs"),
)

const command = Args.text({ name: "command" }).pipe(Args.repeated)

export const run = Command.make(
  "run",
  { ref, instanceType, onDemand, timeout, detach, command },
  ({ ref, instanceType, onDemand, timeout, command }) =>
    Effect.gen(function* () {
      const runs = yield* RunService
      const out = yield* Output

      const started = yield* runs.start({
        command,
        ref: ref._tag === "Some" ? ref.value : undefined,
        instanceType: instanceType._tag === "Some" ? instanceType.value : undefined,
        onDemand,
        timeoutHours: timeout._tag === "Some" ? timeout.value : undefined,
      })

      yield* out.emit({
        data: started,
        human: () =>
          out.print(
            [
              `Run started: ${started.runId}`,
              `  instance     ${started.instanceId} (${started.instanceType}${started.spot ? ", spot" : ", on-demand"})`,
              `  image        ${started.image}`,
              `  branch       ${started.branch}`,
              `  sha          ${started.sha}`,
              `  compose      ${started.composeUsed ? "yes" : "no"}`,
              `  logs         ${started.logGroup}`,
              ``,
              `Follow with: afk logs ${started.runId} --follow`,
              `Attach with: afk attach ${started.runId}`,
            ].join("\n"),
          ),
      })
    }),
)
