import { Effect, Layer } from "effect"
import { SecretStore } from "../../services/backend/SecretStore.ts"
import { Ssm } from "../../adapters/aws/Ssm.ts"
import { ConfigService } from "../../services/ConfigService.ts"
import { DEFAULT_REGION, ssmSecretPrefix } from "../../constants.ts"
import type { Secret } from "../../schema/Secret.ts"

const fullName = (prefix: string, name: string) => `${prefix}/${name}`
const shortName = (prefix: string, full: string) =>
  full.startsWith(`${prefix}/`) ? full.slice(prefix.length + 1) : full

/**
 * AWS implementation of SecretStore. Backed by SSM Parameter Store SecureString
 * entries under `<ssmSecretPrefix>/*` (default `/afk/secrets/*`). Reference
 * syntax in `.afk.env` is `secret:<name>` (canonical) or `ssm:<absolute-path>`
 * (legacy AWS-only).
 */
export const AwsSecretStoreLive = Layer.effect(
  SecretStore,
  Effect.gen(function* () {
    const ssm = yield* Ssm
    const cfg = yield* ConfigService

    const region = cfg.load.pipe(
      Effect.map((r) => r.config.aws?.region ?? DEFAULT_REGION),
    )

    const secretPrefix = cfg.load.pipe(
      Effect.map((r) => ssmSecretPrefix(r.config.aws?.resourcePrefix)),
    )

    return SecretStore.of({
      put: (name, value) =>
        Effect.gen(function* () {
          const r = yield* region
          const prefix = yield* secretPrefix
          yield* ssm.putSecret(r, fullName(prefix, name), value)
        }),

      delete: (name) =>
        Effect.gen(function* () {
          const r = yield* region
          const prefix = yield* secretPrefix
          yield* ssm.deleteParameter(r, fullName(prefix, name))
        }),

      list: Effect.gen(function* () {
        const r = yield* region
        const prefix = yield* secretPrefix
        const params = yield* ssm.listByPrefix(r, prefix)
        return params.map<Secret>((p) => ({
          name: shortName(prefix, p.name),
          reference: p.name,
          lastModified: p.lastModifiedDate,
        }))
      }),
    })
  }),
)
