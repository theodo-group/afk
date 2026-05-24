import { Effect, Layer } from "effect"
import { LogStore } from "../../services/backend/LogStore.ts"
import { ConfigService } from "../../services/ConfigService.ts"
import { CloudflareError, UserError } from "../../infra/Errors.ts"

/**
 * Cloudflare implementation of LogStore. Reads the logs the Run's container
 * shipped back to the launcher Worker on completion (`GET /runs/:id/logs`),
 * the CF analog of CloudWatch on AWS.
 *
 * Logs are captured when the workload exits (the golden bootstrap POSTs them to
 * the Worker's `/runs/:id/complete`), so they're available once the Run is
 * STOPPED. `--follow` against a still-running container can't stream yet — that
 * would need an incremental log push; for now follow just polls the stored log.
 */
export const CloudflareLogStoreLive = Layer.effect(
  LogStore,
  Effect.gen(function* () {
    const cfg = yield* ConfigService

    const authHeaders = (): Record<string, string> => {
      const id = process.env.AFK_CF_CLIENT_ID
      const secret = process.env.AFK_CF_CLIENT_SECRET
      const out: Record<string, string> = {}
      if (id) out["CF-Access-Client-Id"] = id
      if (secret) out["CF-Access-Client-Secret"] = secret
      return out
    }

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
                const res = await fetch(url, { headers: authHeaders() })
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
            yield* Effect.sync(() => process.stdout.write(body.endsWith("\n") || body === "" ? body : body + "\n"))
            return
          }

          // Follow: poll until logs appear (the container ships them on exit),
          // then print once. Ctrl-C to stop.
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
