import { Context, Effect } from "effect"

/** One environment check `afk doctor` renders. */
export interface CheckResult {
  readonly name: string
  readonly ok: boolean
  readonly detail: string
}

/** Smart-constructor for a CheckResult: name + condition + what to say either
 * way — collapses the repeated `{ name, ok, detail: ok ? … : … }` literal that
 * every backend's doctor would otherwise spell out. */
export const check = (
  name: string,
  ok: boolean,
  whenOk: string,
  whenNot: string,
): CheckResult => ({ name, ok, detail: ok ? whenOk : whenNot })

/**
 * Backend-neutral health checks specific to the active Backend — the CLI tools,
 * credentials, and endpoints a given provider needs (AWS: `aws`/`terraform`/
 * `session-manager-plugin` + STS identity; Cloudflare: `wrangler` + API token +
 * launcher Worker reachability).
 *
 * `checks` never fails: each probe captures its own error into a `CheckResult`
 * so `afk doctor` can render every row and decide the exit code itself. The
 * backend-agnostic checks (toolchain binaries, Golden Image freshness) live in
 * the command over neutral seams, not here.
 */
export class BackendDoctor extends Context.Tag("BackendDoctor")<
  BackendDoctor,
  {
    readonly checks: Effect.Effect<ReadonlyArray<CheckResult>>
  }
>() {}
