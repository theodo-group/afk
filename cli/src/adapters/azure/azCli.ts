import { Context, Effect } from "effect"
import { Subprocess } from "../../infra/Subprocess.ts"
import { AzureError } from "../../infra/Errors.ts"

type Sub = Context.Tag.Service<typeof Subprocess>

/** Map a Subprocess/Parse failure into a domain AzureError tagged with the az operation. */
export const azureError =
  (operation: string) =>
  (e: {
    readonly _tag: string
    readonly stderr?: string
    readonly cause?: unknown
  }) =>
    new AzureError({
      operation,
      message: e._tag === "ParseError" ? String(e.cause) : (e.stderr ?? ""),
    })

/**
 * A `Subprocess`-bound view of the `az` CLI that bakes in what every adapter
 * otherwise repeats by hand: the `"az"` command, the output format, the
 * `--only-show-errors` that keeps preview banners out of parsed JSON, and the
 * `operation`-tagged {@link azureError} mapping. Mirrors `gcloudCli.ts`.
 *
 * Interactive calls (`network bastion ssh`) own the TTY and stay on
 * `Subprocess` directly.
 */
export interface AzCli {
  /** `az <args> --output json`, parsed as `T`. */
  readonly json: <T>(
    operation: string,
    args: ReadonlyArray<string>,
    stdin?: string,
  ) => Effect.Effect<T, AzureError>
  /** `az <args> --output none`. */
  readonly run: (
    operation: string,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<void, AzureError>
  /** `az <args> --output tsv`, trimmed — for one raw value. */
  readonly text: (
    operation: string,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<string, AzureError>
  /** `true` iff `az <args>` exits 0 — for show-as-existence probes. */
  readonly exists: (args: ReadonlyArray<string>) => Effect.Effect<boolean>
}

const QUIET = "--only-show-errors"

export const makeAzCli = (sub: Sub): AzCli => ({
  json: <T>(operation: string, args: ReadonlyArray<string>, stdin?: string) =>
    sub
      .runJson<T>(
        "az",
        [...args, "--output", "json", QUIET],
        stdin === undefined ? undefined : { stdin },
      )
      .pipe(Effect.mapError(azureError(operation))),
  run: (operation, args) =>
    sub
      .run("az", [...args, "--output", "none", QUIET])
      .pipe(Effect.asVoid, Effect.mapError(azureError(operation))),
  text: (operation, args) =>
    sub.run("az", [...args, "--output", "tsv", QUIET]).pipe(
      Effect.map((r) => r.stdout.trim()),
      Effect.mapError(azureError(operation)),
    ),
  exists: (args) =>
    sub.run("az", [...args, "--output", "none", QUIET]).pipe(
      Effect.as(true),
      Effect.catchAll(() => Effect.succeed(false)),
    ),
})

/** `--tags k=v …` — one argv entry per tag, so values may hold spaces. */
export const tagArgs = (
  tags: Readonly<Record<string, string>>,
): ReadonlyArray<string> =>
  Object.keys(tags).length === 0
    ? []
    : ["--tags", ...Object.entries(tags).map(([k, v]) => `${k}=${v}`)]
