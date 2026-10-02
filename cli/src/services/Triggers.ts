import { Duration, Either } from "effect"
import type { EntryOutcome, EntryState, Trigger } from "../schema/Schedule.ts"
import { parseSince } from "./SinceWindow.ts"

/**
 * Trigger evaluation, as a functional core. Everything here is a plain
 * function over plain data — no Effect, no Clock, no I/O — so the rules that
 * decide whether a scheduled Run happens are testable without a Layer, and the
 * tick (`Scheduler`) stays a thin shell that performs what this returns.
 *
 * `now` is always passed in. The scheduler reads the clock once per tick and
 * injects it, so a decision is reproducible from its inputs alone.
 */

// ---------- Trigger grammar ----------

/**
 * A Trigger resolved to the form the tick acts on. The file's `after` key
 * carries two of these: a duration literal is a clock, anything else is an
 * edge. Shape is what separates them — which is why an Entry id shaped like a
 * duration is refused at submit (see `validateEntries`).
 */
export type ParsedTrigger =
  | { readonly kind: "at"; readonly atMs: number }
  | { readonly kind: "delay"; readonly delayMs: number }
  | { readonly kind: "cron"; readonly expr: string }
  | {
      readonly kind: "after"
      readonly entryId: string
      readonly requireSuccess: boolean
    }

export const isClock = (t: ParsedTrigger): boolean => t.kind !== "after"

const looksLikeDuration = (s: string): boolean => /^\d+[smhd]$/.test(s.trim())

export const parseTrigger = (
  trigger: Trigger,
): Either.Either<ParsedTrigger, string> => {
  if ("at" in trigger) {
    const atMs = Date.parse(trigger.at)
    return Number.isFinite(atMs)
      ? Either.right({ kind: "at", atMs })
      : Either.left(`'at: ${trigger.at}' is not an ISO-8601 instant`)
  }
  if ("cron" in trigger) {
    return parseCron(trigger.cron) === null
      ? Either.left(
          `'cron: ${trigger.cron}' is not a 5-field cron expression (minute hour day-of-month month day-of-week, UTC)`,
        )
      : Either.right({ kind: "cron", expr: trigger.cron })
  }
  if (looksLikeDuration(trigger.after)) {
    if (trigger.require !== undefined) {
      return Either.left(
        `'require: success' applies only to a dependency trigger, but 'after: ${trigger.after}' is a delay`,
      )
    }
    return Either.match(parseSince(trigger.after), {
      onLeft: () => Either.left(`'after: ${trigger.after}' is not a duration`),
      onRight: (d) =>
        Either.right({
          kind: "delay" as const,
          delayMs: Duration.toMillis(d),
        }),
    })
  }
  return Either.right({
    kind: "after",
    entryId: trigger.after,
    requireSuccess: trigger.require === "success",
  })
}

// ---------- Cron ----------

interface CronField {
  readonly values: ReadonlySet<number>
  readonly wildcard: boolean
}

const parseField = (
  spec: string,
  min: number,
  max: number,
): CronField | null => {
  const parseTerm = (term: string): ReadonlyArray<number> | null => {
    const [range, stepText] = term.split("/")
    if (range === undefined || (stepText !== undefined && stepText === ""))
      return null
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step < 1) return null

    const bounds =
      range === "*"
        ? [min, max]
        : range.includes("-")
          ? range.split("-").map(Number)
          : [Number(range), Number(range)]
    const [lo, hi] = bounds
    if (bounds.length !== 2 || lo === undefined || hi === undefined) return null
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) return null
    if (lo < min || hi > max || lo > hi) return null

    return Array.from(
      { length: Math.floor((hi - lo) / step) + 1 },
      (_, i) => lo + i * step,
    )
  }

  const terms = spec.split(",").map(parseTerm)
  if (terms.some((t) => t === null)) return null
  return {
    values: new Set(terms.flatMap((t) => t as ReadonlyArray<number>)),
    wildcard: spec.trim() === "*",
  }
}

interface CronSpec {
  readonly minute: CronField
  readonly hour: CronField
  readonly dayOfMonth: CronField
  readonly month: CronField
  readonly dayOfWeek: CronField
}

/** Standard 5-field cron, interpreted in UTC. Returns null if unparseable. */
export const parseCron = (expr: string): CronSpec | null => {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const [minute, hour, dayOfMonth, month, dayOfWeek] = [
    parseField(parts[0]!, 0, 59),
    parseField(parts[1]!, 0, 23),
    parseField(parts[2]!, 1, 31),
    parseField(parts[3]!, 1, 12),
    parseField(parts[4]!, 0, 6),
  ]
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) return null
  return { minute, hour, dayOfMonth, month, dayOfWeek }
}

const matchesCron = (spec: CronSpec, d: Date): boolean => {
  if (!spec.minute.values.has(d.getUTCMinutes())) return false
  if (!spec.hour.values.has(d.getUTCHours())) return false
  if (!spec.month.values.has(d.getUTCMonth() + 1)) return false
  // POSIX: when both day fields are restricted they are OR-ed, not AND-ed.
  const domHit = spec.dayOfMonth.values.has(d.getUTCDate())
  const dowHit = spec.dayOfWeek.values.has(d.getUTCDay())
  if (spec.dayOfMonth.wildcard && spec.dayOfWeek.wildcard) return true
  if (spec.dayOfMonth.wildcard) return dowHit
  if (spec.dayOfWeek.wildcard) return domHit
  return domHit || dowHit
}

/**
 * Horizon of the next-match search. A year covers every expression a Schedule
 * realistically carries; a Feb-29-only cron falls outside it and reports no
 * next occurrence rather than searching four years a tick.
 */
const CRON_HORIZON_MINUTES = 366 * 24 * 60

/** The first cron match strictly after `afterMs`, or undefined within the horizon. */
export const nextCronMatch = (
  expr: string,
  afterMs: number,
): number | undefined => {
  const spec = parseCron(expr)
  if (!spec) return undefined
  const firstMinute = Math.floor(afterMs / 60_000) * 60_000 + 60_000
  for (let i = 0; i < CRON_HORIZON_MINUTES; i++) {
    const t = firstMinute + i * 60_000
    if (matchesCron(spec, new Date(t))) return t
  }
  return undefined
}

// ---------- Submit-time validation ----------

export interface EntryDeclaration {
  readonly id: string
  readonly trigger: Trigger
}

/**
 * Every structural problem with a Schedule's Entries, as data. An empty array
 * means the graph is sound: ids unique and unambiguous, each `after` naming a
 * real Entry, no cycle, and every Entry reachable from a clock.
 *
 * Returned rather than thrown so the submit gate can report all of them at
 * once — a developer fixing a Schedule at their desk should not discover the
 * problems one round trip at a time.
 */
export const validateEntries = (
  entries: ReadonlyArray<EntryDeclaration>,
): ReadonlyArray<string> => {
  const duplicates = entries
    .map((e) => e.id)
    .filter((id, i, all) => all.indexOf(id) !== i)
    .filter((id, i, dups) => dups.indexOf(id) === i)
    .map((id) => `duplicate entry id '${id}'`)

  const durationShaped = entries
    .filter((e) => looksLikeDuration(e.id))
    .map(
      (e) =>
        `entry id '${e.id}' is shaped like a duration, so 'after: ${e.id}' would read as a delay — rename it`,
    )

  const parsed = entries.map((e) => ({
    id: e.id,
    parsed: parseTrigger(e.trigger),
  }))
  const malformed = parsed.flatMap(({ id, parsed: p }) =>
    Either.isLeft(p) ? [`entry '${id}': ${p.left}`] : [],
  )
  if (duplicates.length + durationShaped.length + malformed.length > 0) {
    return [...duplicates, ...durationShaped, ...malformed]
  }

  const triggers = new Map(
    parsed.flatMap(({ id, parsed: p }) =>
      Either.isRight(p) ? [[id, p.right] as const] : [],
    ),
  )
  const edges = new Map(
    [...triggers].flatMap(([id, t]) =>
      t.kind === "after" ? [[id, t.entryId] as const] : [],
    ),
  )

  const unknown = [...edges]
    .filter(([, to]) => !triggers.has(to))
    .map(([from, to]) => `entry '${from}': 'after: ${to}' names no Entry`)
  if (unknown.length > 0) return unknown

  // A recurring Entry has no single outcome, so nothing can depend on one.
  const dependsOnCron = [...edges]
    .filter(([, to]) => triggers.get(to)!.kind === "cron")
    .map(
      ([from, to]) =>
        `entry '${from}': cannot depend on '${to}', which is a recurring (cron) Entry with no single outcome`,
    )

  const cycles = findCycles(edges)
  if (cycles.length > 0 || dependsOnCron.length > 0) {
    return [...dependsOnCron, ...cycles]
  }

  // Implied by acyclicity while an Entry has exactly one trigger: following a
  // chain of single edges either lands on a clock or revisits a node. Kept
  // because CONTEXT.md states it as a rule of its own, and it stops being
  // implied the moment a Trigger can name more than one Entry.
  const clocks = new Set(
    [...triggers].flatMap(([id, t]) => (isClock(t) ? [id] : [])),
  )
  const grounded = growGrounded(edges, clocks)
  return [...triggers.keys()]
    .filter((id) => !grounded.has(id))
    .map(
      (id) =>
        `entry '${id}' is not reachable from a clock trigger, so nothing would ever start it`,
    )
}

const findCycles = (
  edges: ReadonlyMap<string, string>,
): ReadonlyArray<string> => {
  // Each Entry has one outgoing edge, so following it either reaches a clock
  // (no edge) or revisits a node — which is the cycle, from that point on.
  const walkFrom = (
    id: string,
    seen: ReadonlyArray<string>,
  ): ReadonlyArray<string> | undefined => {
    const at = seen.indexOf(id)
    if (at !== -1) return seen.slice(at)
    const next = edges.get(id)
    return next === undefined ? undefined : walkFrom(next, [...seen, id])
  }
  const reported = new Set<string>()
  return [...edges.keys()].flatMap((id) => {
    const cycle = walkFrom(id, [])
    if (cycle === undefined || cycle[0] === undefined) return []
    const signature = [...cycle].sort().join(",")
    if (reported.has(signature)) return []
    reported.add(signature)
    return [`cycle: ${[...cycle, cycle[0]].join(" → ")}`]
  })
}

/** Entries reachable from a clock, by repeatedly pulling edge sources in. */
const growGrounded = (
  edges: ReadonlyMap<string, string>,
  seed: ReadonlySet<string>,
): ReadonlySet<string> => {
  const next = new Set(seed)
  for (const [from, to] of edges) if (next.has(to)) next.add(from)
  return next.size === seed.size ? seed : growGrounded(edges, next)
}

/**
 * When a clock Entry first becomes eligible, as an epoch millisecond. The
 * single `not_before` the store holds, so the tick's clock test is one
 * comparison regardless of which clock kind wrote it. Undefined for a
 * dependency Entry, which has no instant of its own.
 */
export const firstDueAt = (
  trigger: ParsedTrigger,
  submittedAtMs: number,
): number | undefined => {
  switch (trigger.kind) {
    case "at":
      return trigger.atMs
    case "delay":
      return submittedAtMs + trigger.delayMs
    case "cron":
      return nextCronMatch(trigger.expr, submittedAtMs)
    case "after":
      return undefined
  }
}

// ---------- The tick's decision ----------

export interface TickEntry {
  readonly scheduleId: string
  readonly entryId: string
  readonly state: EntryState
  readonly trigger: Trigger
  /** ISO instant this Entry becomes eligible; clock Entries only. */
  readonly notBefore?: string
  readonly runId?: string
  readonly launchedAt?: string
  readonly outcome?: EntryOutcome
  readonly timeoutHours: number
}

/** What the Run history says about one launched Entry's Run. */
export interface RunFact {
  readonly runId: string
  readonly running: boolean
  readonly exitCode?: number
}

export type Decision =
  | {
      readonly kind: "launch"
      readonly scheduleId: string
      readonly entryId: string
    }
  | {
      readonly kind: "settle"
      readonly scheduleId: string
      readonly entryId: string
      readonly outcome: EntryOutcome
      readonly reason: string
    }
  | {
      readonly kind: "rearm"
      readonly scheduleId: string
      readonly entryId: string
      readonly notBeforeMs: number
    }

export interface TickInput {
  readonly nowMs: number
  readonly entries: ReadonlyArray<TickEntry>
  readonly runs: ReadonlyArray<RunFact>
  /**
   * How long a launched Entry may go without a history row before it is
   * declared failed. `recordStart` is best-effort (AwsCompute logs and
   * continues), so a Run can exist with no row — and the tick cannot wait on
   * the sweeper, whose reconcile pass swallows its own failures.
   */
  readonly staleAfterMinutes: number
  /** Slack past an Entry's declared timeout before its Run is called hung. */
  readonly graceMinutes: number
}

const keyOf = (scheduleId: string, entryId: string): string =>
  `${scheduleId}\u0000${entryId}`

const MINUTE_MS = 60_000

/**
 * Everything the tick should do, given the clock, the Entries and the Run
 * history. Pure: the caller performs the writes and the launches.
 *
 * Settlements are computed first and fed back into the pending pass, so a
 * dependent Entry can fire on the same tick its dependency finished — and a
 * chain of Entries blocked by a failure collapses in one pass rather than one
 * level per tick.
 */
export const decide = (input: TickInput): ReadonlyArray<Decision> => {
  const runById = new Map(input.runs.map((r) => [r.runId, r]))

  const settlementOf = (e: TickEntry): Decision | undefined => {
    const settle = (outcome: EntryOutcome, reason: string): Decision => ({
      kind: "settle",
      scheduleId: e.scheduleId,
      entryId: e.entryId,
      outcome,
      reason,
    })
    if (e.runId === undefined) {
      return settle("failure", "launched with no Run id recorded")
    }
    const launchedMs = e.launchedAt ? Date.parse(e.launchedAt) : Number.NaN
    const ageMinutes = Number.isFinite(launchedMs)
      ? (input.nowMs - launchedMs) / MINUTE_MS
      : Number.POSITIVE_INFINITY
    const fact = runById.get(e.runId)
    if (!fact) {
      return ageMinutes > input.staleAfterMinutes
        ? settle(
            "failure",
            `no history row for Run ${e.runId} ${Math.round(ageMinutes)} minutes after launch`,
          )
        : undefined
    }
    if (fact.running) {
      return ageMinutes > e.timeoutHours * 60 + input.graceMinutes
        ? settle(
            "failure",
            `Run ${e.runId} still running ${Math.round(ageMinutes)} minutes after launch, past its ${e.timeoutHours}h timeout`,
          )
        : undefined
    }
    // An absent exit code is a failure, never "keep waiting": a reclaimed or
    // crashed VM may never record one, and a dependent would block forever.
    return fact.exitCode === 0
      ? settle("success", `Run ${e.runId} exited 0`)
      : settle(
          "failure",
          fact.exitCode === undefined
            ? `Run ${e.runId} ended without recording an exit code`
            : `Run ${e.runId} exited ${fact.exitCode}`,
        )
  }

  const settlements = input.entries
    .filter((e) => e.state === "launched")
    .flatMap((e) => {
      const d = settlementOf(e)
      return d ? [d] : []
    })

  const rearms = settlements.flatMap((s): ReadonlyArray<Decision> => {
    const entry = input.entries.find(
      (e) => keyOf(e.scheduleId, e.entryId) === keyOf(s.scheduleId, s.entryId),
    )
    if (!entry || !("cron" in entry.trigger)) return []
    const next = nextCronMatch(entry.trigger.cron, input.nowMs)
    return next === undefined
      ? []
      : [
          {
            kind: "rearm",
            scheduleId: s.scheduleId,
            entryId: s.entryId,
            notBeforeMs: next,
          },
        ]
  })

  // Outcome of every Entry that has finished, this tick's settlements included.
  const finished = new Map<string, EntryOutcome>([
    ...input.entries.flatMap((e) =>
      e.state === "done" || e.state === "failed"
        ? ([
            [keyOf(e.scheduleId, e.entryId), e.outcome ?? "failure"],
          ] as ReadonlyArray<readonly [string, EntryOutcome]>)
        : [],
    ),
    ...settlements.flatMap((s) =>
      s.kind === "settle"
        ? ([[keyOf(s.scheduleId, s.entryId), s.outcome]] as ReadonlyArray<
            readonly [string, EntryOutcome]
          >)
        : [],
    ),
  ])

  const pending = input.entries.filter((e) => e.state === "pending")

  const resolvePending = (
    known: ReadonlyMap<string, EntryOutcome>,
    decided: ReadonlyArray<Decision>,
  ): ReadonlyArray<Decision> => {
    const undecided = pending.filter(
      (e) =>
        !decided.some(
          (d) => d.scheduleId === e.scheduleId && d.entryId === e.entryId,
        ),
    )
    const fresh = undecided.flatMap((e): ReadonlyArray<Decision> => {
      const parsed = parseTrigger(e.trigger)
      if (Either.isLeft(parsed)) return []
      const t = parsed.right
      const launch: Decision = {
        kind: "launch",
        scheduleId: e.scheduleId,
        entryId: e.entryId,
      }
      if (t.kind !== "after") {
        const dueMs = e.notBefore ? Date.parse(e.notBefore) : Number.NaN
        return Number.isFinite(dueMs) && input.nowMs >= dueMs ? [launch] : []
      }
      const depOutcome = known.get(keyOf(e.scheduleId, t.entryId))
      if (depOutcome === undefined) return []
      return t.requireSuccess && depOutcome !== "success"
        ? [
            {
              kind: "settle",
              scheduleId: e.scheduleId,
              entryId: e.entryId,
              outcome: "failure",
              reason: `dependency '${t.entryId}' did not succeed`,
            },
          ]
        : [launch]
    })
    if (fresh.length === 0) return decided
    const grown = new Map(known)
    for (const d of fresh) {
      if (d.kind === "settle")
        grown.set(keyOf(d.scheduleId, d.entryId), d.outcome)
    }
    return resolvePending(grown, [...decided, ...fresh])
  }

  return [...settlements, ...rearms, ...resolvePending(finished, [])]
}

/** One-line rendering of a Trigger for `afk schedule ls`. */
export const renderTrigger = (trigger: Trigger): string => {
  const parsed = parseTrigger(trigger)
  if (Either.isLeft(parsed)) return "(invalid)"
  const t = parsed.right
  switch (t.kind) {
    case "at":
      return `at ${new Date(t.atMs).toISOString()}`
    case "delay":
      return `${Math.round(t.delayMs / 60_000)}m after submit`
    case "cron":
      return `cron ${t.expr} (UTC)`
    case "after":
      return t.requireSuccess
        ? `after ${t.entryId} succeeds`
        : `after ${t.entryId} ends`
  }
}
