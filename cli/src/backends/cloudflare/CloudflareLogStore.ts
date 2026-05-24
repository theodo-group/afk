import { Effect, Layer } from "effect"
import { LogStore } from "../../services/backend/LogStore.ts"
import { ConfigService } from "../../services/ConfigService.ts"
import { CloudflareError, UserError } from "../../infra/Errors.ts"
import { cfAuthHeaders } from "./cfAuth.ts"

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
    const cfg = yield* ConfigService

    return LogStore.of({
      tail: (input) =>
        Effect.gen(function* () {
          const { config } = yield* cfg.load
          const workerUrl = config.cloudflare?.workerUrl?.replace(/\/$/, "")
          if (!workerUrl) {
            return yield* Effect.fail(
              new UserError({
                message: "cloudflare.workerUrl is not set in afk.config.json.",
                hint: "Run `afk provision` (or set it to the deployed Worker URL).",
              }),
            )
          }
          const query = input.serviceFilter
            ? `?service=${encodeURIComponent(input.serviceFilter)}`
            : ""
          const url = `${workerUrl}/runs/${encodeURIComponent(input.runId)}/logs${query}`
          const fetchOnce = () =>
            Effect.tryPromise({
              try: async () => {
                const res = await fetch(url, { headers: cfAuthHeaders() })
                if (!res.ok) {
                  throw new CloudflareError({
                    operation: "GET /runs/:id/logs",
                    status: res.status,
                    message: (await res.text()) || res.statusText,
                  })
                }
                return res.text()
              },
              catch: (e): CloudflareError =>
                e instanceof CloudflareError
                  ? e
                  : new CloudflareError({ operation: "logs", message: String(e) }),
            })

          if (!input.follow) {
            const body = yield* fetchOnce()
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
          const statusUrl = `${workerUrl}/runs/${encodeURIComponent(input.runId)}`
          const isStopped = Effect.tryPromise({
            try: async () => {
              const res = await fetch(statusUrl, { headers: cfAuthHeaders() })
              if (!res.ok) return false
              const meta = (await res.json()) as { status?: string }
              return meta.status === "STOPPED"
            },
            catch: (e): CloudflareError =>
              new CloudflareError({ operation: "GET /runs/:id", message: String(e) }),
          }).pipe(Effect.catchAll(() => Effect.succeed(false)))

          let printed = 0
          const drain = Effect.gen(function* () {
            const body = yield* fetchOnce()
            if (body.length > printed) {
              yield* Effect.sync(() => process.stdout.write(body.slice(printed)))
              printed = body.length
            }
          })

          for (;;) {
            yield* drain
            if (yield* isStopped) {
              yield* drain
              return
            }
            yield* Effect.sleep("3 seconds")
          }
        }),
    })
  }),
)
