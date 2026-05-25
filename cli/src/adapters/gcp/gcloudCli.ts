import { Context, Effect } from "effect"
import { Subprocess } from "../../infra/Subprocess.ts"
import { GcpError } from "../../infra/Errors.ts"

type Sub = Context.Tag.Service<typeof Subprocess>

/** Map a Subprocess/Parse failure into a domain GcpError tagged with the gcloud operation. */
export const gcpError =
  (operation: string) =>
  (e: {
    readonly _tag: string
    readonly stderr?: string
    readonly cause?: unknown
  }) =>
    new GcpError({
      operation,
      message: e._tag === "ParseError" ? String(e.cause) : (e.stderr ?? ""),
    })

/**
 * A `Subprocess`-bound view of the `gcloud` CLI that bakes in the three things
 * every adapter otherwise repeats by hand: the `"gcloud"` command, the trailing
 * `--format=json` where JSON is wanted, and the `operation`-tagged
 * {@link gcpError} mapping. Mirrors `adapters/aws/awsCli.ts`.
 *
 * Interactive and streaming calls (`compute ssh --tunnel-through-iap`,
 * `logging read` follow loops) have no JSON to parse and own the TTY, so they
 * stay on `Subprocess` directly.
 */
export interface GcloudCli {
  /** `gcloud <args> --format=json`, parsed as `T`. */
  readonly json: <T>(
    operation: string,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<T, GcpError>
  /** `gcloud <args>`, output discarded. */
  readonly run: (
    operation: string,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<void, GcpError>
  /** `gcloud <args>`, returning trimmed stdout — for raw values like an access token. */
  readonly text: (
    operation: string,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<string, GcpError>
  /** `true` iff `gcloud <args>` exits 0 — for describe-as-existence probes. */
  readonly exists: (args: ReadonlyArray<string>) => Effect.Effect<boolean>
}

export const makeGcloudCli = (sub: Sub): GcloudCli => ({
  json: <T>(operation: string, args: ReadonlyArray<string>) =>
    sub
      .runJson<T>("gcloud", [...args, "--format=json"])
      .pipe(Effect.mapError(gcpError(operation))),
  run: (operation, args) =>
    sub
      .run("gcloud", args)
      .pipe(Effect.asVoid, Effect.mapError(gcpError(operation))),
  text: (operation, args) =>
    sub.run("gcloud", args).pipe(
      Effect.map((r) => r.stdout.trim()),
      Effect.mapError(gcpError(operation)),
    ),
  exists: (args) =>
    sub.run("gcloud", args).pipe(
      Effect.as(true),
      Effect.catchAll(() => Effect.succeed(false)),
    ),
})
