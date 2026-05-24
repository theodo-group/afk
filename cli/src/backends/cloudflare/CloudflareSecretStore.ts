import { Effect, Layer } from "effect"
import { SecretStore } from "../../services/backend/SecretStore.ts"
import type { Secret } from "../../schema/Secret.ts"
import { CfWorker } from "./CfWorker.ts"

/**
 * Cloudflare implementation of SecretStore. Proxies to the launcher Worker's
 * `/secrets` routes; the Worker in turn calls the CF API to set/unset its own
 * Workers Secrets (prefixed `AFK_SECRET_*`).
 */
export const CloudflareSecretStoreLive = Layer.effect(
  SecretStore,
  Effect.gen(function* () {
    const worker = yield* CfWorker

    return SecretStore.of({
      put: (name, value) =>
        worker
          .postJson("POST /secrets/:name", `/secrets/${encodeURIComponent(name)}`, {
            value,
          })
          .pipe(Effect.asVoid),

      delete: (name) =>
        worker
          .del("DELETE /secrets/:name", `/secrets/${encodeURIComponent(name)}`)
          .pipe(Effect.asVoid),

      list: Effect.gen(function* () {
        const out = yield* worker.getJson<{
          secrets: ReadonlyArray<string>
        }>("GET /secrets", "/secrets")
        return out.secrets.map<Secret>((name) => ({
          name,
          reference: `AFK_SECRET_${name}`,
        }))
      }),
    })
  }),
)
