import { Cause, Data, Option } from "effect"

export class UserError extends Data.TaggedError("UserError")<{
  readonly message: string
  readonly hint?: string
}> {}

export class SubprocessError extends Data.TaggedError("SubprocessError")<{
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}> {
  override get message(): string {
    return `\`${this.command} ${this.args.join(" ")}\` failed (exit ${this.exitCode}): ${this.stderr.trim() || this.stdout.trim()}`
  }
}

export class ParseError extends Data.TaggedError("ParseError")<{
  readonly source: string
  readonly cause: unknown
}> {
  override get message(): string {
    return `Failed to parse ${this.source}: ${String(this.cause)}`
  }
}

export class AwsError extends Data.TaggedError("AwsError")<{
  readonly operation: string
  readonly code?: string
  readonly message: string
}> {}

export class DockerError extends Data.TaggedError("DockerError")<{
  readonly operation: string
  readonly message: string
}> {}

export class GitError extends Data.TaggedError("GitError")<{
  readonly operation: string
  readonly message: string
}> {}

export class ConfigError extends Data.TaggedError("ConfigError")<{
  readonly path: string
  readonly message: string
}> {}

/**
 * Generic Cloudflare-side failure (HTTP/WSS/CF-API). Distinct from AwsError so
 * the AWS error channels in the abstract Compute/SecretStore/etc. interfaces
 * can keep their narrow types while the CF Backend reports its own failures.
 */
export class CloudflareError extends Data.TaggedError("CloudflareError")<{
  readonly operation: string
  readonly status?: number
  readonly message: string
}> {}

export type AfkError =
  | UserError
  | SubprocessError
  | ParseError
  | AwsError
  | DockerError
  | GitError
  | ConfigError
  | CloudflareError

/**
 * The single render point for a failed program. A tagged failure (an AfkError,
 * or a @effect/cli ValidationError) becomes `error: <message>` plus an optional
 * `hint:` line; anything else (a defect, an interrupt) falls back to the cause's
 * own string. Called by the top-level `catchAllCause` in `cli.ts`, so the
 * failure channel is `unknown` — the CLI's own errors widen the program's `E`.
 */
export const renderCause = (cause: Cause.Cause<unknown>): string => {
  const failure = Cause.failureOption(cause)
  if (Option.isNone(failure)) return Cause.pretty(cause)
  const err = failure.value
  if (typeof err !== "object" || err === null || !("_tag" in err))
    return Cause.pretty(cause)
  const tagged = err as { _tag: string; message?: string; hint?: string }
  const head = tagged.message ?? tagged._tag
  const tail = tagged.hint ? `\nhint: ${tagged.hint}` : ""
  return `error: ${head}${tail}`
}
