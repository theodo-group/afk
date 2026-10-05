import { Cause, Exit } from "effect"

const SIGNAL_NUMBER = { SIGINT: 2, SIGTERM: 15 } as const
export type HandledSignal = keyof typeof SIGNAL_NUMBER
export const HANDLED_SIGNALS = Object.keys(SIGNAL_NUMBER) as HandledSignal[]

/**
 * The process exit code for how the program ended. The platform's default
 * teardown exits 0 on an interruption, so a caller that killed `afk` on a
 * deadline (the console's `afk logs`) read its empty stdout as a successful,
 * empty answer. An interruption reports the shell's `128 + signal` instead.
 */
export const exitCodeOf = (
  exit: Exit.Exit<unknown, unknown>,
  signal: HandledSignal | undefined,
): number => {
  if (Exit.isSuccess(exit)) return 0
  if (!Cause.isInterruptedOnly(exit.cause)) return 1
  return 128 + SIGNAL_NUMBER[signal ?? "SIGINT"]
}
