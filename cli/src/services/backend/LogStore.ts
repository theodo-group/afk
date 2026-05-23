import { Context, Effect } from "effect"
import { AwsError, ConfigError, UserError } from "../../infra/Errors.ts"

export interface TailInput {
  readonly runId: string
  readonly repoName: string
  readonly serviceFilter?: string
  readonly follow: boolean
  /** Duration string ("30d", "1h", "10m") — only meaningful when follow=false. */
  readonly since?: string
}

/**
 * Backend-neutral log tailing. On AWS the implementation shells out to
 * `aws logs tail`; on Cloudflare it queries Workers Logs (and Tail Workers
 * for follow=true).
 */
export class LogStore extends Context.Tag("LogStore")<
  LogStore,
  {
    /** Stream logs to the caller's stdout. Blocks until done (or Ctrl-C on follow). */
    readonly tail: (
      input: TailInput,
    ) => Effect.Effect<void, AwsError | ConfigError | UserError>
  }
>() {}
