import { Command, Options } from "@effect/cli"
import { Effect } from "effect"
import { RunService } from "../services/RunService.ts"
import { Output } from "../infra/Output.ts"
import {
  DEFAULT_SESSION_TIMEOUT_HOURS,
  SESSION_KEEPALIVE_COMMAND,
} from "../constants.ts"

const ref = Options.text("ref").pipe(Options.optional)
const instanceType = Options.text("instance-type").pipe(Options.optional)
const spot = Options.boolean("spot").pipe(
  Options.withDescription(
    "use interruptible Spot capacity (cheaper, but a reclaim kills your session mid-keystroke; On-Demand by default)",
  ),
)
const timeout = Options.integer("timeout").pipe(
  Options.optional,
  Options.withDescription(
    `wall-clock cap in hours before the box is reclaimed (default ${DEFAULT_SESSION_TIMEOUT_HOURS})`,
  ),
)
const detach = Options.boolean("detach", { aliases: ["d"] }).pipe(
  Options.withDescription(
    "launch without attaching; enter later with `afk attach <run-id>`",
  ),
)
const retain = Options.boolean("retain").pipe(
  Options.withDescription(
    "keep the box (stopped, not reclaimed) after its timeout fires so `afk attach` can resume it later (cloud only; incompatible with --spot)",
  ),
)

/**
 * `afk session` launches an Interactive Run (see CONTEXT.md): a Run with no
 * developer command — afk parks the main service with a keep-alive so there is a
 * live container to enter. It reuses the whole `afk run` pipeline (image build,
 * compose, source clone), differing only in the command slot and two defaults:
 * On-Demand capacity (a Spot reclaim would kill the session) and a longer
 * timeout. After launch it auto-attaches once the box is RUNNING, like
 * `docker run -it`; `-d` launches detached.
 */
export const session = Command.make(
  "session",
  { ref, instanceType, spot, timeout, detach, retain },
  ({ ref, instanceType, spot, timeout, detach, retain }) =>
    Effect.gen(function* () {
      const runs = yield* RunService
      const out = yield* Output

      const backendOverrides: Record<string, string | boolean> = {}
      if (instanceType._tag === "Some")
        backendOverrides.instanceType = instanceType.value
      // An Interactive Run defaults to On-Demand; `--spot` opts back down. The
      // signal is explicit (not just "no on-demand") so the active backend can
      // reject `--spot --retain` rather than silently upgrade it.
      if (spot) backendOverrides.spot = true
      else backendOverrides.onDemand = true

      const started = yield* runs.start({
        command: SESSION_KEEPALIVE_COMMAND,
        ref: ref._tag === "Some" ? ref.value : undefined,
        timeoutHours:
          timeout._tag === "Some"
            ? timeout.value
            : DEFAULT_SESSION_TIMEOUT_HOURS,
        retain,
        backendOverrides,
      })

      yield* out.emit({
        data: started,
        human: () =>
          out.print(
            [
              `Session started: ${started.runId}`,
              `  backend      ${runs.backendName}`,
              `  resource     ${started.resourceId}`,
              `  image        ${started.image}`,
              `  branch       ${started.branch}`,
              detach ? `\nAttach with: afk attach ${started.runId}` : ``,
              `End it with: afk kill ${started.runId}`,
            ]
              .filter(Boolean)
              .join("\n"),
          ),
      })

      if (detach) return

      const status = yield* runs.waitUntilRunning(started.runId, "the session")
      if (status !== "RUNNING") {
        yield* Effect.sync(() =>
          process.stderr.write(
            ` (${status === "GONE" ? "ended" : status.toLowerCase()})\n`,
          ),
        )
        return
      }
      yield* Effect.sync(() => process.stderr.write(" ready, attaching…\n"))

      // The primitive reaching RUNNING does not mean the main service container
      // is execable yet — with sidecars, `docker compose up` holds the agent
      // back until their healthchecks pass. Re-attempt the attach for a bounded
      // window, swallowing the not-ready failures and bailing early if the Run
      // ends; the final attempt below surfaces the real error if it never came
      // up. A successful attach returns the moment the developer detaches.
      const attachOnce = runs.attach(started.runId, {
        service: undefined,
        host: false,
      })
      for (let attempt = 0; attempt < 9; attempt++) {
        const attached = yield* attachOnce.pipe(
          Effect.as(true),
          Effect.catchAll(() => Effect.succeed(false)),
        )
        if (attached) return
        const run = yield* runs
          .findByRunId(started.runId)
          .pipe(Effect.catchAll(() => Effect.succeed(undefined)))
        if (run && run.status !== "RUNNING") break
        yield* Effect.sleep("3 seconds")
      }
      yield* attachOnce
    }),
)
