import { Data } from "effect"

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
