import { Args, Command, Options } from "@effect/cli"
import { Effect } from "effect"
import { RunService } from "../services/RunService.ts"
import { Ec2 } from "../adapters/aws/Ec2.ts"
import { Output } from "../infra/Output.ts"
import { AFK_SECURITY_GROUP, AFK_VPC_NAME } from "../constants.ts"

const region = Options.text("region").pipe(Options.withDefault("us-east-1"))
const ref = Options.text("ref").pipe(Options.optional)
const cpu = Options.integer("cpu").pipe(Options.optional)
const memory = Options.integer("memory").pipe(Options.optional)
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
  { region, ref, cpu, memory, timeout, detach, command },
  ({ region, ref, cpu, memory, timeout, command }) =>
    Effect.gen(function* () {
      const runs = yield* RunService
      const ec2 = yield* Ec2
      const out = yield* Output

      if (command.length === 0) {
        return yield* Effect.die("afk run requires a command")
      }

      const [subnetIds, securityGroupId] = yield* Effect.all([
        ec2.findSubnetIdsByVpcName(AFK_VPC_NAME),
        ec2.findSecurityGroupIdByName(AFK_VPC_NAME, AFK_SECURITY_GROUP),
      ])

      const started = yield* runs.start({
        command,
        ref: ref._tag === "Some" ? ref.value : undefined,
        cpu: cpu._tag === "Some" ? cpu.value : undefined,
        memory: memory._tag === "Some" ? memory.value : undefined,
        timeoutHours: timeout._tag === "Some" ? timeout.value : undefined,
        region,
        subnetIds,
        securityGroupIds: [securityGroupId],
      })

      yield* out.emit({
        data: started,
        human: () =>
          out.print(
            [
              `Run started: ${started.runId}`,
              `  task    ${started.taskArn}`,
              `  image   ${started.image}`,
              `  branch  ${started.branch}`,
              `  sha     ${started.sha}`,
              `  logs    ${started.logGroup}`,
              ``,
              `Follow with: afk logs ${started.runId} --follow`,
              `Attach with: afk attach ${started.runId}`,
            ].join("\n"),
          ),
      })
    }),
)
