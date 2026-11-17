import { Effect, Layer } from "effect"
import { LogStore } from "../../services/backend/LogStore.ts"
import { AzStorage } from "../../adapters/azure/AzStorage.ts"
import { AzAuth } from "../../adapters/azure/AzAuth.ts"
import { ConfigService } from "../../services/ConfigService.ts"
import { AZURE_LOGS_CONTAINER } from "../../constants.ts"
import { makeResolveAzureCoords } from "./azureCoords.ts"

const write = (s: string) => Effect.sync(() => process.stdout.write(s))

/**
 * Azure implementation of LogStore. Azure has no Docker log driver, so a Run's
 * VM re-uploads each service's whole log to `afk-logs/<runId>/<service>.log`
 * (plus `combined.log`) every few seconds and drops a `.done` marker after its
 * last pass — the Cloudflare chunk-shipping shape. So:
 *  - historical: one read, print, done.
 *  - `--follow`: poll the same blob and print each delta; stop after one
 *    final drain once `.done` exists. (`afk run` interrupts this fiber via
 *    streamUntilTerminated; a bare `afk logs --follow` on a Run that died
 *    without its marker polls until Ctrl-C.)
 *
 * `--since` is not honoured: the stored log is the Run's whole output.
 */
export const AzureLogStoreLive = Layer.effect(
  LogStore,
  Effect.gen(function* () {
    const storage = yield* AzStorage
    const auth = yield* AzAuth
    const cfg = yield* ConfigService
    const coords = makeResolveAzureCoords(cfg, auth)

    return LogStore.of({
      tail: (input) =>
        Effect.gen(function* () {
          const { names } = yield* coords
          const account = names.storageAccount
          const blob = `${input.runId}/${input.serviceFilter ?? "combined"}.log`
          const fetchOnce = storage
            .readBlob(account, AZURE_LOGS_CONTAINER, blob)
            .pipe(Effect.map((b) => b ?? ""))

          if (!input.follow) {
            const body = yield* fetchOnce
            return yield* write(
              body === "" || body.endsWith("\n") ? body : `${body}\n`,
            )
          }

          const isDone = storage
            .readBlob(account, AZURE_LOGS_CONTAINER, `${input.runId}/.done`)
            .pipe(
              Effect.map((b) => b !== undefined),
              Effect.catchAll(() => Effect.succeed(false)),
            )

          // Print the bytes past `printed`; return the new high-water mark.
          const drain = (printed: number) =>
            fetchOnce.pipe(
              Effect.tap((body) =>
                body.length > printed
                  ? write(body.slice(printed))
                  : Effect.void,
              ),
              Effect.map((body) => Math.max(printed, body.length)),
            )

          yield* Effect.iterate(
            { printed: 0, done: false },
            {
              while: (s) => !s.done,
              body: (s) =>
                Effect.gen(function* () {
                  const printed = yield* drain(s.printed)
                  if (yield* isDone) {
                    return { printed: yield* drain(printed), done: true }
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
