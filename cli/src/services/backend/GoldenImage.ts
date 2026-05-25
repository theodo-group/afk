import { Context, Effect } from "effect"
import {
  AwsError,
  CloudflareError,
  GcpError,
  ConfigError,
  DockerError,
  UserError,
} from "../../infra/Errors.ts"

/**
 * One Golden Image owned by the active Backend, in neutral terms.
 *
 * `id` is the handle a developer passes to `afk golden rm` — an AMI id on AWS,
 * a registry tag on Cloudflare. `displayName` is the fuller human label (the
 * AMI name / the full `registry…/afk-golden:<tag>` URI). Provider-specific
 * extras (EC2 image state, …) live in `backendDetails`, mirroring `Run`.
 */
export interface GoldenImage {
  readonly id: string
  readonly displayName: string
  readonly version: string
  readonly builtAt: string
  readonly cachedImages: ReadonlyArray<string>
  readonly ready: boolean
  readonly backendDetails?: Record<string, string>
}

export interface GoldenImageBuilt {
  readonly id: string
  readonly displayName: string
  readonly version: string
  readonly builtAt: string
  readonly cachedImages: ReadonlyArray<string>
  /** Free-form note the CLI surfaces after a build, e.g. "patched wrangler.toml". */
  readonly note?: string
}

/**
 * Backend-neutral Golden Image store: build the per-account boot artifact, list
 * what exists, find the newest, and remove one. Each Backend implements this and
 * is wired into its aggregate Layer; `afk golden …` and `afk doctor` depend on
 * the tag, never on a provider impl. The artifact type differs per Backend (an
 * AMI on AWS, a Container image on Cloudflare) but the role is identical.
 */
export class GoldenImageStore extends Context.Tag("GoldenImageStore")<
  GoldenImageStore,
  {
    readonly build: Effect.Effect<
      GoldenImageBuilt,
      | AwsError
      | CloudflareError
      | GcpError
      | DockerError
      | UserError
      | ConfigError
    >
    readonly list: Effect.Effect<
      ReadonlyArray<GoldenImage>,
      | AwsError
      | CloudflareError
      | GcpError
      | DockerError
      | UserError
      | ConfigError
    >
    readonly findLatest: Effect.Effect<
      GoldenImage | null,
      | AwsError
      | CloudflareError
      | GcpError
      | DockerError
      | UserError
      | ConfigError
    >
    readonly remove: (
      id: string,
    ) => Effect.Effect<
      void,
      | AwsError
      | CloudflareError
      | GcpError
      | DockerError
      | UserError
      | ConfigError
    >
  }
>() {}
