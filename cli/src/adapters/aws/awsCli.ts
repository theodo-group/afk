import { Context, Effect } from "effect"
import { Subprocess } from "../../infra/Subprocess.ts"
import { AwsError } from "../../infra/Errors.ts"

type Sub = Context.Tag.Service<typeof Subprocess>

/** Map a Subprocess/Parse failure into a domain AwsError tagged with the API operation. */
export const awsError =
  (operation: string) =>
  (e: {
    readonly _tag: string
    readonly stderr?: string
    readonly cause?: unknown
  }) =>
    new AwsError({
      operation,
      message: e._tag === "ParseError" ? String(e.cause) : (e.stderr ?? ""),
    })

/**
 * A `Subprocess`-bound view of the `aws` CLI that bakes in the three things
 * every adapter otherwise repeats by hand: the `"aws"` command, the trailing
 * `--output json`, and the `operation`-tagged {@link awsError} mapping.
 *
 * Interactive and streaming calls (`ssm start-session`, `logs tail --follow`)
 * have no JSON to parse and own the TTY, so they stay on `Subprocess` directly.
 */
export interface AwsCli {
  /** `aws <args> --output json`, parsed as `T`. */
  readonly json: <T>(
    operation: string,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<T, AwsError>
  /** `aws <args> --output json`, output discarded. */
  readonly run: (
    operation: string,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<void, AwsError>
  /** `aws <args>` (no `--output json`), returning trimmed stdout — for raw values like `get-login-password`. */
  readonly text: (
    operation: string,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<string, AwsError>
  /** `true` iff `aws <args>` exits 0 — for describe-as-existence probes. */
  readonly exists: (args: ReadonlyArray<string>) => Effect.Effect<boolean>
}

export const makeAwsCli = (sub: Sub): AwsCli => ({
  json: <T>(operation: string, args: ReadonlyArray<string>) =>
    sub
      .runJson<T>("aws", [...args, "--output", "json"])
      .pipe(Effect.mapError(awsError(operation))),
  run: (operation, args) =>
    sub
      .run("aws", [...args, "--output", "json"])
      .pipe(Effect.asVoid, Effect.mapError(awsError(operation))),
  text: (operation, args) =>
    sub.run("aws", args).pipe(
      Effect.map((r) => r.stdout.trim()),
      Effect.mapError(awsError(operation)),
    ),
  exists: (args) =>
    sub.run("aws", [...args, "--output", "json"]).pipe(
      Effect.as(true),
      Effect.catchAll(() => Effect.succeed(false)),
    ),
})
