import { Args, Command, Options } from "@effect/cli"
import { Effect } from "effect"
import { RunService } from "../services/RunService.ts"
import { ConfigService } from "../services/ConfigService.ts"
import { Output } from "../infra/Output.ts"

const ref = Options.text("ref").pipe(Options.optional)
const instanceType = Options.text("instance-type").pipe(Options.optional)
const spot = Options.boolean("spot").pipe(
  Options.withDescription(
    "use a Spot instance on AWS (cheaper, but not retainable; on-demand by default)",
  ),
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

const formatBackendDetails = (d: Record<string, string>): string => {
  const keys = Object.keys(d).sort()
  return keys.map((k) => `${k}=${d[k]}`).join(", ")
}

export const run = Command.make(
  "run",
  { ref, instanceType, spot, timeout, detach, dryRun, command },
  ({ ref, instanceType, spot, timeout, detach, dryRun, command }) =>
    Effect.gen(function* () {
      const runs = yield* RunService
      const cfg = yield* ConfigService
      const out = yield* Output

      const backendOverrides: Record<string, string | boolean> = {}
      if (instanceType._tag === "Some")
        backendOverrides.instanceType = instanceType.value
      if (spot) backendOverrides.spot = true

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
        const { sourceRepoName } = yield* cfg.load
        yield* runs.streamUntilTerminated(started.runId, sourceRepoName)
      }
    }),
)
