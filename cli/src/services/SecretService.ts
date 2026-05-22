import { Context, Effect, Layer } from "effect"
import { Ssm } from "../adapters/aws/Ssm.ts"
import { ConfigService } from "./ConfigService.ts"
import { AwsError, ConfigError, UserError } from "../infra/Errors.ts"
import { DEFAULT_REGION, SSM_SECRET_PREFIX } from "../constants.ts"
import type { Secret } from "../schema/Secret.ts"

const fullName = (name: string) => `${SSM_SECRET_PREFIX}/${name}`
const shortName = (full: string) =>
  full.startsWith(`${SSM_SECRET_PREFIX}/`)
    ? full.slice(SSM_SECRET_PREFIX.length + 1)
    : full

export class SecretService extends Context.Tag("SecretService")<
  SecretService,
  {
    readonly put: (
      name: string,
      value: string,
    ) => Effect.Effect<void, AwsError | ConfigError | UserError>
    readonly rm: (
      name: string,
    ) => Effect.Effect<void, AwsError | ConfigError | UserError>
    readonly ls: Effect.Effect<
      ReadonlyArray<Secret>,
      AwsError | ConfigError | UserError
    >
  }
>() {}

export const SecretServiceLive = Layer.effect(
  SecretService,
  Effect.gen(function* () {
    const ssm = yield* Ssm
    const cfg = yield* ConfigService

    const region = cfg.load.pipe(
      Effect.map((r) => r.config.aws?.region ?? DEFAULT_REGION),
    )

    return SecretService.of({
      put: (name, value) =>
        Effect.gen(function* () {
          const r = yield* region
          yield* ssm.putSecret(r, fullName(name), value)
        }),
      rm: (name) =>
        Effect.gen(function* () {
          const r = yield* region
          yield* ssm.deleteParameter(r, fullName(name))
        }),
      ls: Effect.gen(function* () {
        const r = yield* region
        const params = yield* ssm.listByPrefix(r, SSM_SECRET_PREFIX)
        return params.map<Secret>((p) => ({
          name: shortName(p.name),
          ssmName: p.name,
          lastModified: p.lastModifiedDate,
        }))
      }),
    })
  }),
)
