import { Context, Effect, Layer } from "effect"
import { ConfigService } from "../../services/ConfigService.ts"
import { CloudflareError, UserError } from "../../infra/Errors.ts"
import type { ConfigError } from "../../infra/Errors.ts"
import { cfAuthHeaders } from "./cfAuth.ts"

/**
 * Client for the launcher Worker's HTTP surface. Every CLI → Worker call goes
 * through here: it owns base-URL resolution (`cloudflare.workerUrl`), the
 * Cloudflare Access service-token headers, the `!res.ok` → `CloudflareError`
 * mapping, and JSON (de)serialization. Paths passed in are relative
 * ("/runs", `/runs/${id}`); the client prepends the resolved base.
 */
export class CfWorker extends Context.Tag("CfWorker")<
  CfWorker,
  {
    readonly getJson: <T>(
      operation: string,
      path: string,
    ) => Effect.Effect<T, CloudflareError | UserError | ConfigError>
    readonly postJson: <T>(
      operation: string,
      path: string,
      body?: unknown,
    ) => Effect.Effect<T, CloudflareError | UserError | ConfigError>
    readonly del: <T>(
      operation: string,
      path: string,
      body?: unknown,
    ) => Effect.Effect<T, CloudflareError | UserError | ConfigError>
    readonly getText: (
      operation: string,
      path: string,
    ) => Effect.Effect<string, CloudflareError | UserError | ConfigError>
  }
>() {}

export const CfWorkerLive = Layer.effect(
  CfWorker,
  Effect.gen(function* () {
    const cfg = yield* ConfigService

    const resolveBase = Effect.gen(function* () {
      const { config } = yield* cfg.load
      const url = config.cloudflare?.workerUrl
      if (!url) {
        return yield* Effect.fail(
          new UserError({
            message: "cloudflare.workerUrl is not set in afk.config.json.",
            hint: "After `wrangler deploy`, set the workers.dev URL (or your custom hostname) into cloudflare.workerUrl.",
          }),
        )
      }
      return url.replace(/\/$/, "")
    })

    const request = (operation: string, path: string, init?: RequestInit) =>
      Effect.gen(function* () {
        const base = yield* resolveBase
        return yield* Effect.tryPromise({
          try: async () => {
            const res = await fetch(`${base}${path}`, {
              ...init,
              headers: { ...cfAuthHeaders(), ...(init?.headers ?? {}) },
            })
            const text = await res.text()
            if (!res.ok) {
              throw new CloudflareError({
                operation,
                status: res.status,
                message: text || res.statusText,
              })
            }
            return text
          },
          catch: (e): CloudflareError =>
            e instanceof CloudflareError
              ? e
              : new CloudflareError({ operation, message: String(e) }),
        })
      })

    const asJson = <T>(text: string): T =>
      text ? (JSON.parse(text) as T) : ({} as T)

    return CfWorker.of({
      getJson: <T>(operation: string, path: string) =>
        request(operation, path).pipe(Effect.map((text) => asJson<T>(text))),

      postJson: <T>(operation: string, path: string, body?: unknown) =>
        request(operation, path, {
          method: "POST",
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        }).pipe(Effect.map((text) => asJson<T>(text))),

      del: <T>(operation: string, path: string, body?: unknown) =>
        request(operation, path, {
          method: "DELETE",
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        }).pipe(Effect.map((text) => asJson<T>(text))),

      getText: (operation: string, path: string) => request(operation, path),
    })
  }),
)
