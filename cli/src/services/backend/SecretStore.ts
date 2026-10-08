import { Context, Effect } from "effect"
import {
  AwsError,
  CloudflareError,
  GcpError,
  ConfigError,
  UserError,
} from "../../infra/Errors.ts"
import type { Secret, SecretScope } from "../../schema/Secret.ts"

/**
 * Backend-neutral secret store.
 *
 * The Run-time path (decrypting secrets and injecting them into the Container's
 * environment) is the Backend's responsibility — not exposed here. On AWS the
 * VM's instance profile resolves SSM parameters at boot. On Cloudflare the
 * launcher Worker reads Workers Secrets at Container spawn time. This service
 * is only the developer-facing CRUD on the secret store.
 *
 * Every operation names a `scope`: `team` secrets are shared by the project,
 * `personal` ones belong to the calling [[owner]] and are readable only by that
 * Owner's Runs. A Backend that cannot isolate one Owner's Runs from another's
 * refuses `personal` with a UserError rather than store it as a team secret.
 */
export class SecretStore extends Context.Tag("SecretStore")<
  SecretStore,
  {
    readonly put: (
      name: string,
      value: string,
      scope: SecretScope,
    ) => Effect.Effect<
      void,
      AwsError | CloudflareError | GcpError | ConfigError | UserError
    >

    readonly delete: (
      name: string,
      scope: SecretScope,
    ) => Effect.Effect<
      void,
      AwsError | CloudflareError | GcpError | ConfigError | UserError
    >

    readonly list: (
      scope: SecretScope,
    ) => Effect.Effect<
      ReadonlyArray<Secret>,
      AwsError | CloudflareError | GcpError | ConfigError | UserError
    >
  }
>() {}

/**
 * The refusal a Backend returns for a `personal` secret it cannot isolate: one
 * whose Runs all share an identity, so any Run could read any Owner's value.
 */
export const personalSecretsUnsupported = (backend: string): UserError =>
  new UserError({
    message: `personal secrets are not supported on the ${backend} Backend.`,
    hint: "Its Runs share one identity, so a personal secret would be readable by every Run. Use a team secret (`secret:<name>`, `afk secrets put <name>`).",
  })
