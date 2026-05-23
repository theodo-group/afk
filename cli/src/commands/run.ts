import { Args, Command, Options } from "@effect/cli"
import { Effect } from "effect"
import { RunService } from "../services/RunService.ts"
import { Ec2 } from "../adapters/aws/Ec2.ts"
import { ConfigService } from "../services/ConfigService.ts"
import { LogStore } from "../services/backend/LogStore.ts"
import { Compute } from "../services/backend/Compute.ts"
import { Output } from "../infra/Output.ts"
import { DEFAULT_REGION, LOG_GROUP_PREFIX } from "../constants.ts"

const ref = Options.text("ref").pipe(Options.optional)
const instanceType = Options.text("instance-type").pipe(Options.optional)
const onDemand = Options.boolean("on-demand").pipe(
  Options.withDescription("disable Spot on AWS (Runs use Spot by default)"),
)
const timeout = Options.integer("timeout").pipe(
  Options.optional,
  Options.withDescription("wall-clock cap in hours"),
)
const detach = Options.boolean("detach", { aliases: ["d"] }).pipe(
  Options.withDescription(
    "return immediately after launch; without this flag, afk run streams logs until the Run terminates",
  ),
)
const dryRun = Options.boolean("dry-run").pipe(
  Options.withDescription(
    "print the resolved launch plan (instance type/tier, image, env, compose, …) and exit without launching",
  ),
)

const command = Args.text({ name: "command" }).pipe(Args.repeated)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * AWS-only fallback streaming behavior for `afk run` (no --detach). Other
 * Backends will own their own streaming impl; this function is referenced
 * only when `RunService.backendName === "aws"`.
 *
 * After RunInstances returns, polls for the VM to reach `running`, then
 * spawns `aws logs tail --follow` and polls for terminal state to know when
 * to stop the tail. Honors Ctrl-C as a clean detach.
 */
const streamAwsUntilTerminated = (input: {
  readonly region: string
  readonly instanceId: string
  readonly runId: string
  readonly repoName: string
}): Effect.Effect<void, never, Ec2> =>
  Effect.gen(function* () {
    const ec2 = yield* Ec2

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
        process.stderr.write(` (state: ${state})\n`)
        return
      }
      yield* Effect.promise(() => sleep(3000))
      process.stderr.write(".")
    }
    process.stderr.write(" ready, streaming logs (Ctrl-C to detach)\n")

    const group = `${LOG_GROUP_PREFIX}/${input.repoName}`
    const streamPrefix = `${input.runId}/`

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
        /* ignore */
      }
    }
    process.once("SIGINT", onSig)
    process.once("SIGTERM", onSig)

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
            await sleep(3_000)
            try {
              proc.kill()
            } catch {
              /* ignore */
            }
            return
          }
        } catch {
          /* transient errors: keep polling */
        }
      }
    })()

    yield* Effect.promise(async () => {
      await Promise.race([proc.exited, poll])
      try {
        proc.kill()
      } catch {
        /* ignore */
      }
      process.removeListener("SIGINT", onSig)
      process.removeListener("SIGTERM", onSig)
    })
  })

/**
 * Cloudflare equivalent of streamAwsUntilTerminated: tail Workers Logs via
 * the LogStore tag and concurrently poll Compute.findByRunId to discover when
 * the Run reaches a terminal state.
 */
const streamCloudflareUntilTerminated = (input: {
  readonly runId: string
  readonly repoName: string
}): Effect.Effect<void, never, LogStore | Compute> =>
  Effect.gen(function* () {
    const logs = yield* LogStore
    const compute = yield* Compute

    // Kick off the log tail. We don't await it — we race it against the
    // terminal-state poll below and kill it via SIGINT when the Run ends.
    const tailFiber = yield* Effect.forkDaemon(
      logs
        .tail({ runId: input.runId, repoName: input.repoName, follow: true })
        .pipe(Effect.catchAll(() => Effect.void)),
    )

    let stop = false
    const onSig = () => {
      stop = true
    }
    process.once("SIGINT", onSig)
    process.once("SIGTERM", onSig)

    while (!stop) {
      yield* Effect.promise(() => sleep(8000))
      const run = yield* compute
        .findByRunId(input.runId)
        .pipe(Effect.catchAll(() => Effect.succeed(null)))
      if (
        run &&
        (run.status === "STOPPED" || run.status === "STOPPING")
      ) {
        break
      }
    }

    process.removeListener("SIGINT", onSig)
    process.removeListener("SIGTERM", onSig)
    // Best-effort cleanup of the daemon fiber. The process is about to exit
    // (or move on to printing the final summary) so an in-flight tail is fine
    // to abandon.
    void tailFiber
  })

const formatBackendDetails = (d: Record<string, string>): string => {
  const keys = Object.keys(d).sort()
  return keys.map((k) => `${k}=${d[k]}`).join(", ")
}

export const run = Command.make(
  "run",
  { ref, instanceType, onDemand, timeout, detach, dryRun, command },
  ({ ref, instanceType, onDemand, timeout, detach, dryRun, command }) =>
    Effect.gen(function* () {
      const runs = yield* RunService
      const cfg = yield* ConfigService
      const out = yield* Output

      const backendOverrides: Record<string, string | boolean> = {}
      if (instanceType._tag === "Some")
        backendOverrides.instanceType = instanceType.value
      if (onDemand) backendOverrides.onDemand = true

      const planInput = {
        command,
        ref: ref._tag === "Some" ? ref.value : undefined,
        timeoutHours: timeout._tag === "Some" ? timeout.value : undefined,
        backendOverrides,
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
                `  backend           ${runs.backendName}`,
                `  image             ${plan.image}`,
                `  branch            ${plan.branch}`,
                `  sha               ${plan.sha}`,
                `  compose           ${plan.composeUsed ? `yes (main: ${plan.mainService})` : "no"}`,
                `  timeout           ${plan.timeoutHours}h (${plan.timeoutSeconds}s)`,
                `  env (plain)       ${plan.env.map((e) => e.name).join(", ") || "(none)"}`,
                `  secrets           ${plan.secrets.map((s) => `${s.name}→${s.secretName}`).join(", ") || "(none)"}`,
                `  log channel       ${plan.logChannel}`,
                `  backend plan      ${JSON.stringify(plan.backendPlan, null, 2)}`,
                ``,
                `Remove --dry-run to launch.`,
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
              `  backend      ${runs.backendName}`,
              `  resource     ${started.resourceId} (${formatBackendDetails(started.backendDetails)})`,
              `  image        ${started.image}`,
              `  branch       ${started.branch}`,
              `  sha          ${started.sha}`,
              `  compose      ${started.composeUsed ? "yes" : "no"}`,
              `  logs         ${started.logChannel}`,
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
        if (runs.backendName === "aws") {
          const region = config.aws?.region ?? DEFAULT_REGION
          yield* streamAwsUntilTerminated({
            region,
            instanceId: started.resourceId,
            runId: started.runId,
            repoName: sourceRepoName,
          })
        } else if (runs.backendName === "cloudflare") {
          yield* streamCloudflareUntilTerminated({
            runId: started.runId,
            repoName: sourceRepoName,
          })
        }
      }
    }),
)
