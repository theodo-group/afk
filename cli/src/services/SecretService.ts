import { Context, Effect, Layer } from "effect"
import { SecretStore } from "./backend/SecretStore.ts"
import { AwsError, CloudflareError, ConfigError, UserError } from "../infra/Errors.ts"
import type { Secret } from "../schema/Secret.ts"

/**
 * Thin proxy over the active Backend's SecretStore. Commands depend on this
 * tag so they don't have to know which Backend is wired in.
 */
export class SecretService extends Context.Tag("SecretService")<
  SecretService,
  {
    readonly put: (
      name: string,
      value: string,
    ) => Effect.Effect<void, AwsError | CloudflareError | ConfigError | UserError>
    readonly rm: (
      name: string,
    ) => Effect.Effect<void, AwsError | CloudflareError | ConfigError | UserError>
    readonly ls: Effect.Effect<
      ReadonlyArray<Secret>,
      AwsError | CloudflareError | ConfigError | UserError
    >
  }
>() {}

export const SecretServiceLive = Layer.effect(
  SecretService,
  Effect.gen(function* () {
    const store = yield* SecretStore
    return SecretService.of({
      put: store.put,
      rm: store.delete,
      ls: store.list,
    })
  }),
)
