import { Effect, Layer } from "effect"
import {
  SecretStore,
  personalSecretsUnsupported,
} from "../../services/backend/SecretStore.ts"
import type { Secret } from "../../schema/Secret.ts"
import { CfWorker } from "./CfWorker.ts"

/**
 * Cloudflare implementation of SecretStore. Proxies to the launcher Worker's
 * `/secrets` routes; the Worker in turn calls the CF API to set/unset its own
 * Workers Secrets (prefixed `AFK_SECRET_*`). Every Run is spawned by the same
 * Worker, so a personal secret could not be kept from another Owner's Run: the
 * `personal` scope is refused.
 */
export const CloudflareSecretStoreLive = Layer.effect(
  SecretStore,
  Effect.gen(function* () {
    const worker = yield* CfWorker

    const refusePersonal = Effect.fail(personalSecretsUnsupported("Cloudflare"))

    return SecretStore.of({
      put: (name, value, scope) =>
        scope === "personal"
          ? refusePersonal
          : worker
              .postJson(
                "POST /secrets/:name",
                `/secrets/${encodeURIComponent(name)}`,
                {
                  value,
                },
              )
              .pipe(Effect.asVoid),

      delete: (name, scope) =>
        scope === "personal"
          ? refusePersonal
          : worker
              .del(
                "DELETE /secrets/:name",
                `/secrets/${encodeURIComponent(name)}`,
              )
              .pipe(Effect.asVoid),

      list: (scope) =>
        scope === "personal"
          ? refusePersonal
          : worker
              .getJson<{ secrets: ReadonlyArray<string> }>(
                "GET /secrets",
                "/secrets",
              )
              .pipe(
                Effect.map((out) =>
                  out.secrets.map<Secret>((name) => ({
                    name,
                    scope: "team",
                    reference: `AFK_SECRET_${name}`,
                  })),
                ),
              ),
    })
  }),
)
