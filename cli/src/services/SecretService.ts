import { Context, Effect, Layer } from "effect"
import { Ssm } from "../adapters/aws/Ssm.ts"
import { AwsError } from "../infra/Errors.ts"
import { SSM_SECRET_PREFIX } from "../constants.ts"
import type { Secret } from "../schema/Secret.ts"

const fullName = (name: string) => `${SSM_SECRET_PREFIX}/${name}`
const shortName = (full: string) =>
  full.startsWith(`${SSM_SECRET_PREFIX}/`)
    ? full.slice(SSM_SECRET_PREFIX.length + 1)
    : full

export class SecretService extends Context.Tag("SecretService")<
  SecretService,
  {
    readonly put: (name: string, value: string) => Effect.Effect<void, AwsError>
    readonly rm: (name: string) => Effect.Effect<void, AwsError>
    readonly ls: Effect.Effect<ReadonlyArray<Secret>, AwsError>
  }
>() {}

export const SecretServiceLive = Layer.effect(
  SecretService,
  Effect.gen(function* () {
    const ssm = yield* Ssm
    return SecretService.of({
      put: (name, value) => ssm.putSecret(fullName(name), value),
      rm: (name) => ssm.deleteParameter(fullName(name)),
      ls: ssm.listByPrefix(SSM_SECRET_PREFIX).pipe(
        Effect.map((params) =>
          params.map<Secret>((p) => ({
            name: shortName(p.name),
            ssmName: p.name,
            lastModified: p.lastModifiedDate,
          })),
        ),
      ),
    })
  }),
)
