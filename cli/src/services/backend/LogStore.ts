import { Context, Effect } from "effect"
import {
  AwsError,
  CloudflareError,
  GcpError,
  ConfigError,
  UserError,
} from "../../infra/Errors.ts"

export interface TailInput {
  readonly runId: string
  readonly repoName: string
  readonly serviceFilter?: string
  readonly follow: boolean
  /** `--since` as the user gave it: a duration ("30d", "1h") or an ISO timestamp. */
  readonly since?: string
  /** The Run's start (ISO), when known: where a read with no `--since` begins. */
  readonly startedAt?: string
}

/**
 * Backend-neutral log tailing. On AWS the implementation shells out to
 * `aws logs tail`; on Cloudflare it reads the per-Run logs the container ships
 * to the launcher Worker on exit (`GET /runs/:id/logs`), polling that endpoint
 * when follow=true.
 */
export class LogStore extends Context.Tag("LogStore")<
  LogStore,
  {
    /** Stream logs to the caller's stdout. Blocks until done (or Ctrl-C on follow). */
    readonly tail: (
      input: TailInput,
    ) => Effect.Effect<
      void,
      AwsError | CloudflareError | GcpError | ConfigError | UserError
    >
  }
>() {}
