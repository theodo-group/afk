import { Effect, Layer } from "effect"
import { SecretStore } from "../../services/backend/SecretStore.ts"
import { Ssm } from "../../adapters/aws/Ssm.ts"
import { Sts } from "../../adapters/aws/Sts.ts"
import { ConfigService } from "../../services/ConfigService.ts"
import { DEFAULT_REGION, ssmSecretPrefix } from "../../constants.ts"
import { UserError } from "../../infra/Errors.ts"
import { isValidSecretName } from "../../schema/Secret.ts"
import type { Secret, SecretScope } from "../../schema/Secret.ts"
import {
  ownerTags,
  personalSecretPath,
  requireNamedOwner,
} from "./AwsPersonalSecrets.ts"

const fullName = (prefix: string, name: string) => `${prefix}/${name}`
const shortName = (prefix: string, full: string) =>
  full.startsWith(`${prefix}/`) ? full.slice(prefix.length + 1) : full

/**
 * AWS implementation of SecretStore. Backed by SSM Parameter Store SecureString
 * entries: team secrets under `<ssmSecretPrefix>/*` (default `/afk/secrets/*`),
 * personal ones under the caller's `/afk/personal/<owner key>/*`, tagged with
 * their userid (see AwsPersonalSecrets). Reference syntax in `.afk.env` is
 * `secret:<name>` (canonical), `personal-secret:<name>`, or
 * `ssm:<absolute-path>` (legacy AWS-only).
 */
export const AwsSecretStoreLive = Layer.effect(
  SecretStore,
  Effect.gen(function* () {
    const ssm = yield* Ssm
    const sts = yield* Sts
    const cfg = yield* ConfigService

    const region = cfg.load.pipe(
      Effect.map((r) => r.config.aws?.region ?? DEFAULT_REGION),
    )

    const resourcePrefix = cfg.load.pipe(
      Effect.map((r) => r.config.aws?.resourcePrefix),
    )

    const owner = sts.callerIdentity.pipe(
      Effect.flatMap((id) => requireNamedOwner(id.UserId)),
    )

    // Where a scope's secrets live, for the caller.
    const pathOf = (scope: SecretScope) =>
      Effect.gen(function* () {
        const prefix = yield* resourcePrefix
        return scope === "personal"
          ? personalSecretPath(prefix, yield* owner)
          : ssmSecretPrefix(prefix)
      })

    const checkName = (name: string) =>
      isValidSecretName(name)
        ? Effect.void
        : Effect.fail(
            new UserError({
              message: `invalid secret name '${name}'`,
              hint: "Use letters, digits, '.', '_' and '-' only.",
            }),
          )

    return SecretStore.of({
      put: (name, value, scope) =>
        Effect.gen(function* () {
          yield* checkName(name)
          const r = yield* region
          const path = fullName(yield* pathOf(scope), name)
          if (scope === "personal") {
            yield* ssm.putTaggedSecret(r, path, value, ownerTags(yield* owner))
          } else {
            yield* ssm.putSecret(r, path, value)
          }
        }),

      delete: (name, scope) =>
        Effect.gen(function* () {
          const r = yield* region
          yield* ssm.deleteParameter(r, fullName(yield* pathOf(scope), name))
        }),

      list: (scope) =>
        Effect.gen(function* () {
          const r = yield* region
          const path = yield* pathOf(scope)
          const params = yield* ssm.listByPrefix(r, `${path}/`)
          return params.map<Secret>((p) => ({
            name: shortName(path, p.name),
            scope,
            reference: p.name,
            lastModified: p.lastModifiedDate,
          }))
        }),
    })
  }),
)
