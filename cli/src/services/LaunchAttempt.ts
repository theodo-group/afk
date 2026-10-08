/**
 * What the Scheduler does when it cannot launch an Entry's Run.
 *
 * Pure: a plain decision over the error and the attempts already spent, so the
 * policy is tested without a Layer and without fabricating an AWS failure.
 *
 * The distinction that matters is *where in the lifecycle* the failure lands.
 * A launch that was refused created no Run, so nothing happened and retrying
 * is free. A Run that started and then died is the opposite: it may already
 * have pushed commits, commented on a ticket or spent Claude quota, so it
 * settles and is never retried. Only this side of the line retries.
 */
export type LaunchFailureAction = "retry" | "settle"

/**
 * Default-retry, bounded — not a list of retryable provider error codes.
 *
 * An allow-list is a maintenance treadmill against someone else's error
 * taxonomy, and its failure mode is the damaging one: a code nobody listed
 * kills an unattended Schedule for the night. `InsufficientInstanceCapacity`
 * on Spot at 23:00 is the normal case, not an exception. So anything that
 * might pass is retried within a budget, and the budget is what stops a
 * genuinely broken Entry retrying forever.
 *
 * A `UserError` is the exception: it is the developer's to fix by definition,
 * and it will not fix itself before the next tick. Reporting it immediately
 * beats spending the budget to say the same thing fifteen minutes later.
 */
export const launchFailureAction = (
  error: { readonly _tag: string },
  attemptsIncludingThis: number,
  budget: number,
): LaunchFailureAction =>
  error._tag === "UserError" || attemptsIncludingThis >= budget
    ? "settle"
    : "retry"

/**
 * The short form of a launch failure, for an Entry's row and the `ls` table.
 * An AWS error code (`InsufficientInstanceCapacity`) says more in one word
 * than the first line of a CLI traceback, so it wins when present; the full
 * text still goes to the log.
 */
export const launchFailureDetail = (error: {
  readonly _tag: string
  readonly code?: string | undefined
  readonly message?: string | undefined
}): string =>
  error.code ?? error.message?.trim().split("\n")[0]?.trim() ?? error._tag
