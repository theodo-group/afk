import { Effect, Layer } from "effect"
import { LogStore } from "../../services/backend/LogStore.ts"
import { ConfigService } from "../../services/ConfigService.ts"
import { Subprocess } from "../../infra/Subprocess.ts"
import { CloudflareError, UserError } from "../../infra/Errors.ts"

/**
 * Cloudflare implementation of LogStore. Streams via `wrangler tail` and
 * filters its JSON output for the requested runId.
 *
 * For `follow=false` we fall back to `wrangler tail --since <since>` (which
 * exits when there are no more events) rather than going through CF GraphQL
 * Analytics, since the exact GraphQL query shape for Workers Logs is fiddly
 * and varies by account plan. A future revision should switch to the
 * GraphQL endpoint to avoid the wrangler runtime dependency.
 *
 * TODO: verify GraphQL Analytics shape at
 * https://developers.cloudflare.com/analytics/graphql-api/
 */
export const CloudflareLogStoreLive = Layer.effect(
  LogStore,
  Effect.gen(function* () {
    const cfg = yield* ConfigService
    const _sub = yield* Subprocess // ensure the dep is satisfied for layer wiring

    return LogStore.of({
      tail: (input) =>
        Effect.gen(function* () {
          const { config } = yield* cfg.load
          const workerName = config.cloudflare?.workerName
          if (!workerName) {
            return yield* Effect.fail(
              new UserError({
                message: "cloudflare.workerName is not set in afk.config.json.",
                hint: "Set it to the name of the deployed launcher Worker.",
              }),
            )
          }

          // `wrangler tail` is a LIVE stream only — it has no `--since`/history
          // flag (passing one errors). Historical reads need the GraphQL
          // Analytics API (tracked as a separate improvement). For now both
          // follow and non-follow tail live; non-follow simply streams until
          // interrupted.
          const args = ["tail", workerName, "--format", "json"]

          // Stream wrangler stdout line-by-line, parse JSON, filter for our
          // runId, and write the `log.message` payload to our stdout. We can't
          // use the inheritStdio Subprocess.run for this because we need to
          // see + filter each line.
          yield* Effect.tryPromise({
            try: () =>
              new Promise<void>((resolveP, rejectP) => {
                const proc = Bun.spawn(["wrangler", ...args], {
                  stdout: "pipe",
                  stderr: "inherit",
                  stdin: "ignore",
                })
                let buf = ""
                const reader = proc.stdout.getReader()
                const decoder = new TextDecoder()
                const drain = async () => {
                  try {
                    for (;;) {
                      const { value, done } = await reader.read()
                      if (done) break
                      buf += decoder.decode(value, { stream: true })
                      let nl: number
                      while ((nl = buf.indexOf("\n")) >= 0) {
                        const line = buf.slice(0, nl)
                        buf = buf.slice(nl + 1)
                        if (!line.trim()) continue
                        try {
                          const ev = JSON.parse(line) as {
                            logs?: Array<{ message?: unknown[] }>
                            outcome?: string
                            event?: unknown
                          }
                          // Find anything that looks like a runId match in the
                          // log payload — the Worker logs `{runId, line}` as
                          // its own JSON, so a substring match is enough.
                          if (line.includes(input.runId)) {
                            // Extract `line` from the structured payload if
                            // present, else dump the whole line.
                            const fromLogs =
                              ev.logs?.flatMap((l) => l.message ?? []) ?? []
                            for (const item of fromLogs) {
                              if (typeof item === "string") {
                                process.stdout.write(item + "\n")
                              } else if (
                                item &&
                                typeof item === "object" &&
                                "line" in (item as Record<string, unknown>) &&
                                typeof (item as { line: unknown }).line === "string" &&
                                ((item as { runId?: unknown }).runId === undefined ||
                                  (item as { runId?: unknown }).runId === input.runId)
                              ) {
                                process.stdout.write(
                                  (item as { line: string }).line + "\n",
                                )
                              }
                            }
                            if (fromLogs.length === 0) {
                              process.stdout.write(line + "\n")
                            }
                          }
                        } catch {
                          /* not JSON — skip */
                        }
                      }
                    }
                    resolveP()
                  } catch (e) {
                    rejectP(e)
                  }
                }
                const onSig = () => {
                  try {
                    proc.kill()
                  } catch {
                    /* ignore */
                  }
                }
                process.once("SIGINT", onSig)
                process.once("SIGTERM", onSig)
                drain().finally(() => {
                  process.removeListener("SIGINT", onSig)
                  process.removeListener("SIGTERM", onSig)
                })
              }),
            catch: (e): CloudflareError =>
              new CloudflareError({
                operation: "wrangler tail",
                message: String(e),
              }),
          })
        }),
    })
  }),
)
