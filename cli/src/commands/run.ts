import { Args, Command, Options } from "@effect/cli"
import { Effect } from "effect"
import { RunService } from "../services/RunService.ts"
import { Ec2 } from "../adapters/aws/Ec2.ts"
import { ConfigService } from "../services/ConfigService.ts"
import { Output } from "../infra/Output.ts"
import { DEFAULT_REGION, LOG_GROUP_PREFIX } from "../constants.ts"

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
  Options.withDescription(
    "return immediately after launch; without this flag, afk run streams logs until the VM terminates",
  ),
)
const dryRun = Options.boolean("dry-run").pipe(
  Options.withDescription(
    "print the resolved launch plan (instance type, AMI, env, compose, user_data preview) and exit without launching",
  ),
)

const command = Args.text({ name: "command" }).pipe(Args.repeated)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * After RunInstances returns, follow logs until the VM reaches a terminal
 * state. Kills the tail process on termination or Ctrl-C.
 */
const streamUntilTerminated = (input: {
  readonly region: string
  readonly instanceId: string
  readonly runId: string
  readonly repoName: string
}): Effect.Effect<void, never, Ec2> =>
  Effect.gen(function* () {
    const ec2 = yield* Ec2

    // Wait for the instance to reach `running` so logs have started flowing.
    yield* Effect.sync(() => process.stderr.write("waiting for VM to boot…"))
    while (true) {
      const insts = yield* ec2
        .describeInstances({
          region: input.region,
          instanceIds: [input.instanceId],
        })
        .pipe(Effect.catchAll(() => Effect.succeed([])))
      const state = insts[0]?.state
      if (state === "running") break
      if (state && state !== "pending") {
        // Already past running (stopped/terminated/etc.)
        process.stderr.write(` (state: ${state})\n`)
        return
      }
      yield* Effect.promise(() => sleep(3000))
      process.stderr.write(".")
    }
    process.stderr.write(" ready, streaming logs (Ctrl-C to detach)\n")

    const group = `${LOG_GROUP_PREFIX}/${input.repoName}`
    const streamPrefix = `${input.runId}/`

    // Spawn `aws logs tail --follow` with inherited stdio so users see output
    // as it arrives. Keep the handle so we can kill it on termination.
    const proc = Bun.spawn(
      [
        "aws",
        "logs",
        "tail",
        group,
        "--region",
        input.region,
        "--follow",
        "--since",
        "10m",
        "--log-stream-name-prefix",
        streamPrefix,
        "--format",
        "short",
      ],
      { stdout: "inherit", stderr: "inherit", stdin: "ignore" },
    )

    let detached = false
    const onSig = () => {
      detached = true
      try {
        proc.kill()
      } catch {
        // ignore
      }
    }
    process.once("SIGINT", onSig)
    process.once("SIGTERM", onSig)

    // Poll instance state every 10s; when terminated, kill tail and exit.
    const poll = (async () => {
      while (!detached) {
        await sleep(10_000)
        try {
          const insts = await Effect.runPromise(
            ec2.describeInstances({
              region: input.region,
              instanceIds: [input.instanceId],
            }),
          )
          const state = insts[0]?.state
          if (
            state === "shutting-down" ||
            state === "stopping" ||
            state === "stopped" ||
            state === "terminated" ||
            state === undefined
          ) {
            // Give the tail one extra cycle to flush late events.
            await sleep(3_000)
            try {
              proc.kill()
            } catch {
              // ignore
            }
            return
          }
        } catch {
          // transient DescribeInstances failures: keep polling
        }
      }
    })()

    yield* Effect.promise(async () => {
      await Promise.race([proc.exited, poll])
      try {
        proc.kill()
      } catch {
        // ignore
      }
      process.removeListener("SIGINT", onSig)
      process.removeListener("SIGTERM", onSig)
    })
  })

export const run = Command.make(
  "run",
  { ref, instanceType, onDemand, timeout, detach, dryRun, command },
  ({ ref, instanceType, onDemand, timeout, detach, dryRun, command }) =>
    Effect.gen(function* () {
      const runs = yield* RunService
      const cfg = yield* ConfigService
      const out = yield* Output

      const planInput = {
        command,
        ref: ref._tag === "Some" ? ref.value : undefined,
        instanceType: instanceType._tag === "Some" ? instanceType.value : undefined,
        onDemand,
        timeoutHours: timeout._tag === "Some" ? timeout.value : undefined,
      }

      if (dryRun) {
        const plan = yield* runs.prepare(planInput)
        yield* out.emit({
          data: plan,
          human: () =>
            out.print(
              [
                `Dry-run plan (no resources launched):`,
                `  run id            ${plan.runId}`,
                `  region            ${plan.region}`,
                `  instance type     ${plan.instanceType}${plan.spot ? " (spot)" : " (on-demand)"}`,
                `  golden AMI        ${plan.amiId}`,
                `  subnet candidates ${plan.subnetIds.join(", ")}`,
                `  security group    ${plan.securityGroupId}`,
                `  timeout           ${plan.timeoutHours}h (${plan.timeoutSeconds}s)`,
                `  image             ${plan.image}${plan.imageWasSkipped ? " (already in ECR)" : " (would be built+pushed)"}`,
                `  branch            ${plan.branch}`,
                `  sha               ${plan.sha}`,
                `  compose           ${plan.composePresent ? "yes (main: " + plan.mainService + ")" : "no"}`,
                `  env (plain)       ${plan.env.map((e) => e.name).join(", ") || "(none)"}`,
                `  secrets (ssm)     ${plan.secrets.map((s) => `${s.name}->${s.ssmName}`).join(", ") || "(none)"}`,
                `  log group         ${plan.logGroup}`,
                ``,
                `Add --dry-run=false (or just remove it) to actually launch.`,
              ].join("\n"),
            ),
        })
        return
      }

      const started = yield* runs.start(planInput)

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
              detach
                ? `Follow with: afk logs ${started.runId} --follow`
                : `Streaming logs (Ctrl-C to detach, the Run keeps going)…`,
              detach ? `Attach with: afk attach ${started.runId}` : ``,
            ]
              .filter(Boolean)
              .join("\n"),
          ),
      })

      if (!detach) {
        const { config, sourceRepoName } = yield* cfg.load
        const region = config.aws?.region ?? DEFAULT_REGION
        yield* streamUntilTerminated({
          region,
          instanceId: started.instanceId,
          runId: started.runId,
          repoName: sourceRepoName,
        })
      }
    }),
)
