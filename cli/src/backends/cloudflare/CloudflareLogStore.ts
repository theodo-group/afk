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

          // Follow: poll until logs appear (the container ships them on exit),
          // then print incrementally. Ctrl-C to stop.
          let printed = 0
          for (;;) {
            const body = yield* fetchOnce()
            if (body.length > printed) {
              yield* Effect.sync(() => process.stdout.write(body.slice(printed)))
              printed = body.length
            }
            yield* Effect.sleep("3 seconds")
          }
        }),
    })
  }),
)
