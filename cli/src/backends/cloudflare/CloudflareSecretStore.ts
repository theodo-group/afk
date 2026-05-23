import { Effect, Layer } from "effect"
import { SecretStore } from "../../services/backend/SecretStore.ts"
import { ConfigService } from "../../services/ConfigService.ts"
import { CloudflareError, ConfigError, UserError } from "../../infra/Errors.ts"
import type { Secret } from "../../schema/Secret.ts"

const authHeaders = (): Record<string, string> => {
  const id = process.env.AFK_CF_CLIENT_ID
  const secret = process.env.AFK_CF_CLIENT_SECRET
  const out: Record<string, string> = { "content-type": "application/json" }
  if (id) out["CF-Access-Client-Id"] = id
  if (secret) out["CF-Access-Client-Secret"] = secret
  return out
}

/**
 * Cloudflare implementation of SecretStore. Proxies to the launcher Worker's
 * `/secrets` routes; the Worker in turn calls the CF API to set/unset its own
 * Workers Secrets (prefixed `AFK_SECRET_*`).
 */
export const CloudflareSecretStoreLive = Layer.effect(
  SecretStore,
  Effect.gen(function* () {
    const cfg = yield* ConfigService

    const resolveWorkerUrl = Effect.gen(function* () {
      const { config } = yield* cfg.load
      const url = config.cloudflare?.workerUrl
      if (!url) {
        return yield* Effect.fail(
          new UserError({
            message: "cloudflare.workerUrl is not set in afk.config.json.",
          }),
        )
      }
      return url.replace(/\/$/, "")
    })

    const call = (
      operation: string,
      path: string,
      init?: RequestInit,
    ): Effect.Effect<unknown, CloudflareError | UserError | ConfigError> =>
      Effect.gen(function* () {
        const base = yield* resolveWorkerUrl
        return yield* Effect.tryPromise({
          try: async () => {
            const res = await fetch(`${base}${path}`, {
              ...init,
              headers: { ...authHeaders(), ...(init?.headers ?? {}) },
            })
            const text = await res.text()
            if (!res.ok) {
              throw new CloudflareError({
                operation,
                status: res.status,
                message: text || res.statusText,
              })
            }
            return text ? JSON.parse(text) : {}
          },
          catch: (e): CloudflareError =>
            e instanceof CloudflareError
              ? e
              : new CloudflareError({ operation, message: String(e) }),
        })
      })

    return SecretStore.of({
      put: (name, value) =>
        call("POST /secrets/:name", `/secrets/${encodeURIComponent(name)}`, {
          method: "POST",
          body: JSON.stringify({ value }),
        }).pipe(Effect.asVoid),

      delete: (name) =>
        call("DELETE /secrets/:name", `/secrets/${encodeURIComponent(name)}`, {
          method: "DELETE",
        }).pipe(Effect.asVoid),

      list: Effect.gen(function* () {
        const out = (yield* call("GET /secrets", "/secrets")) as {
          secrets: ReadonlyArray<string>
        }
        return out.secrets.map<Secret>((name) => ({
          name,
          ssmName: `AFK_SECRET_${name}`,
        }))
      }),

      referenceFor: (name) => `secret:${name}`,
    })
  }),
)
