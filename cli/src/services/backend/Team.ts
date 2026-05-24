import { Context, Effect } from "effect"
import { AwsError, CloudflareError, ConfigError, UserError } from "../../infra/Errors.ts"
import type { TeamMember } from "../../schema/TeamMember.ts"

export interface AddMemberResult {
  readonly member: TeamMember
  /** AWS-only: a new IAM-user access key, shown once. */
  readonly accessKey?: { readonly accessKeyId: string; readonly secretAccessKey: string }
  /** CF-only: a new Access service-token client credential, shown once. */
  readonly serviceToken?: {
    readonly clientId: string
    readonly clientSecret: string
  }
}

/**
 * Backend-neutral team-membership store.
 *
 * Each Backend scopes who may launch and act on Runs through its own principal
 * model. On AWS membership is IAM users (and trusted principals on the
 * afk-developer role); on Cloudflare it is Access service tokens managed by the
 * launcher Worker. This service is the developer-facing CRUD over that store.
 */
export class Team extends Context.Tag("Team")<
  Team,
  {
    readonly add: (input: {
      readonly name: string
      readonly principal?: string
    }) => Effect.Effect<AddMemberResult, AwsError | CloudflareError | UserError | ConfigError>
    readonly ls: Effect.Effect<
      ReadonlyArray<TeamMember>,
      AwsError | CloudflareError | UserError | ConfigError
    >
    readonly rm: (
      name: string,
    ) => Effect.Effect<void, AwsError | CloudflareError | UserError | ConfigError>
  }
>() {}
