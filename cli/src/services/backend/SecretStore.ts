import { Context, Effect } from "effect"
import {
  AwsError,
  CloudflareError,
  GcpError,
  ConfigError,
  UserError,
} from "../../infra/Errors.ts"
import type { Secret } from "../../schema/Secret.ts"

/**
 * Backend-neutral secret store.
 *
 * The Run-time path (decrypting secrets and injecting them into the Container's
 * environment) is the Backend's responsibility — not exposed here. On AWS the
 * VM's instance profile resolves SSM parameters at boot. On Cloudflare the
 * launcher Worker reads Workers Secrets at Container spawn time. This service
 * is only the developer-facing CRUD on the secret store.
 */
export class SecretStore extends Context.Tag("SecretStore")<
  SecretStore,
  {
    readonly put: (
      name: string,
      value: string,
    ) => Effect.Effect<
      void,
      AwsError | CloudflareError | GcpError | ConfigError | UserError
    >

    readonly delete: (
      name: string,
    ) => Effect.Effect<
      void,
      AwsError | CloudflareError | GcpError | ConfigError | UserError
    >

    readonly list: Effect.Effect<
      ReadonlyArray<Secret>,
      AwsError | CloudflareError | GcpError | ConfigError | UserError
    >
  }
>() {}
