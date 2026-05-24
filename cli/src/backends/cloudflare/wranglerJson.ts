import { Effect } from "effect"
import { CloudflareError } from "../../infra/Errors.ts"

/**
 * Slice the first top-level JSON array out of wrangler's stdout and parse it.
 *
 * wrangler prints human banners (telemetry notice, "agent skills" notice, …) to
 * stdout before the JSON payload, so we cut from the first `[` to the last `]`
 * rather than parsing raw. Both the "no array found" and "unparseable" cases
 * fail in the error channel as a `CloudflareError` — never a thrown defect.
 */
export const parseWranglerJsonArray = <T>(
  stdout: string,
  operation: string,
): Effect.Effect<ReadonlyArray<T>, CloudflareError> =>
  Effect.try({
    try: () => {
      const start = stdout.indexOf("[")
      const end = stdout.lastIndexOf("]")
      if (start === -1 || end === -1 || end < start) {
        throw new Error(`no JSON array in output: ${stdout.slice(0, 200)}`)
      }
      return JSON.parse(stdout.slice(start, end + 1)) as ReadonlyArray<T>
    },
    catch: (cause) =>
      new CloudflareError({
        operation,
        message: `could not parse wrangler images JSON: ${String(cause)}`,
      }),
  })
