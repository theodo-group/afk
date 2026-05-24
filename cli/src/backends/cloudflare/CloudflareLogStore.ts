import { Effect, Layer } from "effect"
import { LogStore } from "../../services/backend/LogStore.ts"
import { CfWorker } from "./CfWorker.ts"

/**
 * Cloudflare implementation of LogStore.
 *
 * Both read paths share one source: the launcher Worker's
 * `GET /runs/:id/logs`. The CF Backend has no live log-driver — instead the
 * container's golden bootstrap pushes a growing per-service snapshot to
 * `POST /runs/:id/logs-progress` every few seconds while the workload runs, and
 * ships the authoritative copy to `/runs/:id/complete` on exit. The Worker
 * stores the latest snapshot (keyed `<service>`) and serves it back here. So:
 *  - historical (non-follow): one fetch, print, done.
 *  - `--follow`: poll the same endpoint and print incrementally as the stored
 *    snapshot grows (live, not only at completion).
 *
 * `--since` is not honoured: the stored log is the Run's whole bounded output
 * with no per-line timestamps to window against.
 */
export const CloudflareLogStoreLive = Layer.effect(
  LogStore,
  Effect.gen(function* () {
    const worker = yield* CfWorker

    return LogStore.of({
      tail: (input) =>
        Effect.gen(function* () {
          const query = input.serviceFilter
            ? `?service=${encodeURIComponent(input.serviceFilter)}`
            : ""
          const logsPath = `/runs/${encodeURIComponent(input.runId)}/logs${query}`
          const fetchOnce = worker.getText("GET /runs/:id/logs", logsPath)

          if (!input.follow) {
            const body = yield* fetchOnce
            return yield* Effect.sync(() =>
              process.stdout.write(body === "" ? "" : body.endsWith("\n") ? body : body + "\n"),
            )
          }

          // Follow: the container pushes a growing snapshot every few seconds
          // (the golden bootstrap's log poller), so poll the same endpoint and
          // print each delta. Stop once the Run is terminal — `/complete` stores
          // the authoritative logs before flipping status to STOPPED, so one
          // final drain after we see STOPPED is race-free. (`afk run` interrupts
          // this fiber via streamUntilTerminated; a bare `afk logs --follow` on a
          // finished Run would otherwise poll a static snapshot forever.)
          const statusPath = `/runs/${encodeURIComponent(input.runId)}`
          const isStopped = worker
            .getJson<{ status?: string }>("GET /runs/:id", statusPath)
            .pipe(
              Effect.map((meta) => meta.status === "STOPPED"),
              Effect.catchAll(() => Effect.succeed(false)),
            )

          // Drain prints the byte-delta beyond `printed` and returns the new
          // high-water mark, threaded as `Effect.iterate` state.
          const drain = (printed: number) =>
            fetchOnce.pipe(
              Effect.tap((body) =>
                body.length > printed
                  ? Effect.sync(() => process.stdout.write(body.slice(printed)))
                  : Effect.void,
              ),
              Effect.map((body) => Math.max(printed, body.length)),
            )

          // State threads `printed` plus a `done` flag; once STOPPED we run one
          // final drain (so the authoritative snapshot lands) and then halt.
          yield* Effect.iterate(
            { printed: 0, done: false },
            {
              while: (state) => !state.done,
              body: (state) =>
                Effect.gen(function* () {
                  const printed = yield* drain(state.printed)
                  if (yield* isStopped) {
                    const final = yield* drain(printed)
                    return { printed: final, done: true }
                  }
                  yield* Effect.sleep("3 seconds")
                  return { printed, done: false }
                }),
            },
          )
        }),
    })
  }),
)
