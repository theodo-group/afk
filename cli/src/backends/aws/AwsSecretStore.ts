import { Effect, Layer } from "effect"
import { SecretStore } from "../../services/backend/SecretStore.ts"
import { Ssm } from "../../adapters/aws/Ssm.ts"
import { ConfigService } from "../../services/ConfigService.ts"
import {
  DEFAULT_REGION,
  SSM_SECRET_PREFIX,
} from "../../constants.ts"
import type { Secret } from "../../schema/Secret.ts"

const fullName = (name: string) => `${SSM_SECRET_PREFIX}/${name}`
const shortName = (full: string) =>
  full.startsWith(`${SSM_SECRET_PREFIX}/`)
    ? full.slice(SSM_SECRET_PREFIX.length + 1)
    : full

/**
 * AWS implementation of SecretStore. Backed by SSM Parameter Store SecureString
 * entries under `/afk/secrets/*`. Reference syntax in `.afk.env` is
 * `secret:<name>` (canonical) or `ssm:<absolute-path>` (legacy AWS-only).
 */
export const AwsSecretStoreLive = Layer.effect(
  SecretStore,
  Effect.gen(function* () {
    const ssm = yield* Ssm
    const cfg = yield* ConfigService

    const region = cfg.load.pipe(
      Effect.map((r) => r.config.aws?.region ?? DEFAULT_REGION),
    )

    return SecretStore.of({
      put: (name, value) =>
        Effect.gen(function* () {
          const r = yield* region
          yield* ssm.putSecret(r, fullName(name), value)
        }),

      delete: (name) =>
        Effect.gen(function* () {
          const r = yield* region
          yield* ssm.deleteParameter(r, fullName(name))
        }),

      list: Effect.gen(function* () {
        const r = yield* region
        const params = yield* ssm.listByPrefix(r, SSM_SECRET_PREFIX)
        return params.map<Secret>((p) => ({
          name: shortName(p.name),
          reference: p.name,
          lastModified: p.lastModifiedDate,
        }))
      }),
    })
  }),
)
