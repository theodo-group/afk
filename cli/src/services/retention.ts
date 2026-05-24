/**
 * Pure retention arithmetic, shared by the Backends that retain a finished
 * Run's compute primitive (Local, AWS on-demand). No I/O, no clock — the clock
 * (`nowMs`) and the finished timestamp are injected so these are trivially
 * testable, matching the functional-core convention (see code-style.md §4).
 *
 * A retained Run is reclaimed once it is older than `retentionDays` past the
 * point it finished. See CONTEXT.md "Retention".
 */

const DAY_MS = 86_400_000

/** When a Run that finished at `finishedAtIso` will be auto-reclaimed. */
export const retainedUntilIso = (
  finishedAtIso: string,
  retentionDays: number,
): string =>
  new Date(Date.parse(finishedAtIso) + retentionDays * DAY_MS).toISOString()

/** Whether a Run that finished at `finishedAtIso` is past its retention window. */
export const isExpired = (
  finishedAtIso: string,
  nowMs: number,
  retentionDays: number,
): boolean => nowMs > Date.parse(finishedAtIso) + retentionDays * DAY_MS
