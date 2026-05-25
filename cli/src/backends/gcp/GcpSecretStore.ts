import { Effect, Layer } from "effect"
import { SecretStore } from "../../services/backend/SecretStore.ts"
import { SecretManager } from "../../adapters/gcp/SecretManager.ts"
import { Auth } from "../../adapters/gcp/Auth.ts"
import { ConfigService } from "../../services/ConfigService.ts"
import { GCP_SECRET_PREFIX } from "../../constants.ts"
import type { Secret } from "../../schema/Secret.ts"

const fullName = (name: string) => `${GCP_SECRET_PREFIX}-${name}`
const shortName = (full: string) =>
  full.startsWith(`${GCP_SECRET_PREFIX}-`)
    ? full.slice(GCP_SECRET_PREFIX.length + 1)
    : full

/**
 * GCP implementation of SecretStore. Backed by Secret Manager secrets named
 * `afk-secret-<name>`. The Run-time path dereferences them via the instance
 * SA's `roles/secretmanager.secretAccessor` (see the startup-script); this seam
 * is only the developer-facing CRUD.
 */
export const GcpSecretStoreLive = Layer.effect(
  SecretStore,
  Effect.gen(function* () {
    const sm = yield* SecretManager
    const auth = yield* Auth
    const cfg = yield* ConfigService

    const project = Effect.gen(function* () {
      const { config } = yield* cfg.load
      return config.gcp?.projectId ?? (yield* auth.activeProject)
    })

    return SecretStore.of({
      put: (name, value) =>
        Effect.gen(function* () {
          const p = yield* project
          yield* sm.putSecret(p, fullName(name), value)
        }),

      delete: (name) =>
        Effect.gen(function* () {
          const p = yield* project
          yield* sm.deleteSecret(p, fullName(name))
        }),

      list: Effect.gen(function* () {
        const p = yield* project
        const secrets = yield* sm.listByPrefix(p, GCP_SECRET_PREFIX)
        return secrets.map<Secret>((s) => ({
          name: shortName(s.name),
          reference: s.name,
          lastModified: s.createTime,
        }))
      }),
    })
  }),
)
