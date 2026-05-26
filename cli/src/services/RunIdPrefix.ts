import { Either } from "effect"
import { UserError } from "../infra/Errors.ts"
import type { Run } from "../schema/Run.ts"

/**
 * Resolve a runId or its leading prefix to a single Run. Lets the CLI accept
 * `afk logs 295f1be2` for a Run whose full id is `295f1be2-2028-…` without
 * the developer having to copy the whole UUID.
 *
 * An exact id match always wins so a copy-pasted full id stays unambiguous
 * even if a shorter id would also have prefix-matched. Multiple prefix
 * matches fail with a UserError that lists the candidates so the developer
 * can disambiguate with a longer prefix.
 */
export const resolveRunByIdPrefix = (
  idOrPrefix: string,
  runs: ReadonlyArray<Run>,
): Either.Either<Run, UserError> => {
  const exact = runs.find((r) => r.runId === idOrPrefix)
  if (exact) return Either.right(exact)
  const matches = runs.filter((r) => r.runId.startsWith(idOrPrefix))
  if (matches.length === 1) return Either.right(matches[0]!)
  if (matches.length === 0) {
    return Either.left(
      new UserError({
        message: `Run ${idOrPrefix} not found.`,
        hint: "Use `afk ls` to see available Runs.",
      }),
    )
  }
  return Either.left(
    new UserError({
      message: `Run id prefix '${idOrPrefix}' is ambiguous (${matches.length} matches).`,
      hint:
        "Use a longer prefix. Matches:\n" +
        matches.map((r) => `  ${r.runId}`).join("\n"),
    }),
  )
}
