import { Effect, Layer } from "effect"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { LogStore } from "../../services/backend/LogStore.ts"
import { Subprocess } from "../../infra/Subprocess.ts"
import { runLogsDir } from "./localPaths.ts"

/**
 * Local implementation of LogStore.
 *
 * The Run's outer container bind-mounts `~/.afk/runs/<runId>` from the host, and
 * its bootstrap streams the workload's combined output to `logs/combined.log`
 * there (and dumps per-service `logs/<svc>.log` on exit). So the host can read
 * logs straight off disk — no `docker logs` round-trip and no shipping step.
 * Live Runs and terminated ones read the same files, which is what keeps
 * `afk logs <run>` working after the Run ends.
 *
 * `--since` has no effect locally (these are plain files, not a timestamped log
 * store); follow uses `tail -F` so a not-yet-created file is picked up once the
 * bootstrap starts writing.
 */
export const LocalLogStoreLive = Layer.effect(
  LogStore,
  Effect.gen(function* () {
    const sub = yield* Subprocess

    return LogStore.of({
      tail: (input) =>
        Effect.gen(function* () {
          // serviceFilter set (default = main service, or --service <name>):
          // tail only that service's file. No filter (--all): the prefixed
          // combined log. The per-service files are written live by the
          // bootstrap, so this scopes correctly even while the Run is alive —
          // never falling back to the all-services combined log.
          const logsDir = runLogsDir(input.runId)
          const file = input.serviceFilter
            ? resolve(logsDir, `${input.serviceFilter}.log`)
            : resolve(logsDir, "combined.log")

          if (input.follow) {
            // `stream` kills `tail` when the surrounding Effect is interrupted
            // (Ctrl-C, or RunService stopping the tail at terminal state).
            yield* sub
              .stream("tail", ["-n", "+1", "-F", file])
              .pipe(Effect.catchAll(() => Effect.void))
            return
          }

          if (!existsSync(file)) {
            yield* Effect.sync(() =>
              process.stderr.write(`(no logs recorded for ${input.runId})\n`),
            )
            return
          }
          yield* sub
            .runInteractive("cat", [file])
            .pipe(Effect.catchAll(() => Effect.void))
        }),
    })
  }),
)
