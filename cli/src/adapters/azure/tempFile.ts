import { Effect } from "effect"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AzureError } from "../../infra/Errors.ts"

/**
 * Hand `use` the path of a private temp file holding `content`, removed once
 * `use` ends however it ends. For the `az` arguments that only take a file —
 * VM custom data, run-command scripts, and secret values, which must never sit
 * in argv where any local `ps` can read them.
 */
export const withTempFile = <A, E, R>(
  name: string,
  content: string,
  use: (path: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | AzureError, R> =>
  Effect.acquireUseRelease(
    Effect.try({
      try: () => {
        const dir = mkdtempSync(join(tmpdir(), "afk-az-"))
        const path = join(dir, name)
        writeFileSync(path, content, { mode: 0o600 })
        return { dir, path }
      },
      catch: (cause) =>
        new AzureError({ operation: "tempfile:write", message: String(cause) }),
    }),
    ({ path }) => use(path),
    ({ dir }) =>
      Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
  )
