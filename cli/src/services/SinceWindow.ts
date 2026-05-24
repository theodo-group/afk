import { Duration, Either } from "effect"
import { UserError } from "../infra/Errors.ts"

/**
 * The single owner of the `--since` window grammar. Parses a compact duration
 * token (`7d`, `24h`, `30m`, `10s`) into an Effect `Duration`. Pure: no Clock,
 * no `Date`, no I/O — callers resolve it to an instant against `DateTime.now`.
 */
export const parseSince = (token: string): Either.Either<Duration.Duration, UserError> => {
  const m = /^(\d+)([smhd])$/.exec(token.trim())
  if (!m) {
    return Either.left(
      new UserError({
        message: `Invalid --since: '${token}'.`,
        hint: "Use a duration like 24h, 7d, 30d.",
      }),
    )
  }
  const n = Number(m[1]!)
  const unit = m[2]!
  const duration =
    unit === "s"
      ? Duration.seconds(n)
      : unit === "m"
        ? Duration.minutes(n)
        : unit === "h"
          ? Duration.hours(n)
          : Duration.days(n)
  return Either.right(duration)
}
