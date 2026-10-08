import { describe, expect, it } from "bun:test"
import { Either } from "effect"
import type { Trigger } from "../schema/Schedule.ts"
import {
  decide,
  firstDueAt,
  nextCronMatch,
  parseTrigger,
  validateEntries,
  type RunFact,
  type TickEntry,
  type TickInput,
} from "./Triggers.ts"

const NOW = Date.parse("2026-10-02T23:05:00Z")

const entry = (
  over: Partial<TickEntry> & Pick<TickEntry, "entryId">,
): TickEntry => ({
  scheduleId: "nightly",
  state: "pending",
  trigger: { at: "2026-10-02T23:00:00Z" },
  timeoutHours: 4,
  ...over,
})

const tick = (over: Partial<TickInput>): TickInput => ({
  nowMs: NOW,
  entries: [],
  runs: [],
  staleAfterMinutes: 5,
  graceMinutes: 30,
  ...over,
})

describe("parseTrigger — the three kinds", () => {
  it("reads an instant", () => {
    expect(parseTrigger({ at: "2026-10-02T23:00:00Z" })).toEqual(
      Either.right({ kind: "at", atMs: Date.parse("2026-10-02T23:00:00Z") }),
    )
  })

  it("reads a duration under the same key as a dependency", () => {
    expect(parseTrigger({ after: "2h" })).toEqual(
      Either.right({ kind: "delay", delayMs: 2 * 60 * 60 * 1000 }),
    )
    expect(parseTrigger({ after: "spec-contrat" })).toEqual(
      Either.right({
        kind: "after",
        entryId: "spec-contrat",
        requireSuccess: false,
      }),
    )
  })

  it("carries require: success onto the edge", () => {
    expect(parseTrigger({ after: "spec-contrat", require: "success" })).toEqual(
      Either.right({
        kind: "after",
        entryId: "spec-contrat",
        requireSuccess: true,
      }),
    )
  })

  it("refuses require: success on a delay — there is no outcome to require", () => {
    expect(
      Either.isLeft(parseTrigger({ after: "2h", require: "success" })),
    ).toBe(true)
  })

  it("refuses a malformed instant and a malformed cron", () => {
    expect(Either.isLeft(parseTrigger({ at: "tomorrow night" }))).toBe(true)
    expect(Either.isLeft(parseTrigger({ cron: "0 23 * *" }))).toBe(true)
    expect(Either.isLeft(parseTrigger({ cron: "61 * * * *" }))).toBe(true)
  })
})

describe("nextCronMatch — UTC, strictly after", () => {
  it("finds the next daily occurrence", () => {
    expect(
      new Date(
        nextCronMatch("0 23 * * *", Date.parse("2026-10-02T22:00:00Z"))!,
      ),
    ).toEqual(new Date("2026-10-02T23:00:00Z"))
  })

  it("never returns the instant it was given", () => {
    const at = Date.parse("2026-10-02T23:00:00Z")
    expect(nextCronMatch("0 23 * * *", at)).toBe(
      Date.parse("2026-10-03T23:00:00Z"),
    )
  })

  it("honours a restricted day-of-month on its own", () => {
    expect(nextCronMatch("0 0 1 * *", Date.parse("2026-10-02T20:00:00Z"))).toBe(
      Date.parse("2026-11-01T00:00:00Z"),
    )
  })

  it("ORs day-of-month with day-of-week when both are restricted", () => {
    // POSIX: '1st of the month OR any Monday', not their intersection.
    // 2026-10-05 is the first Monday after the 2nd, and comes before the 1st.
    expect(nextCronMatch("0 0 1 * 1", Date.parse("2026-10-02T20:00:00Z"))).toBe(
      Date.parse("2026-10-05T00:00:00Z"),
    )
  })

  it("honours steps, lists and day-of-week", () => {
    expect(
      nextCronMatch("*/15 * * * *", Date.parse("2026-10-02T23:01:00Z")),
    ).toBe(Date.parse("2026-10-02T23:15:00Z"))
    // 2026-10-05 is a Monday.
    expect(nextCronMatch("0 9 * * 1", Date.parse("2026-10-02T23:00:00Z"))).toBe(
      Date.parse("2026-10-05T09:00:00Z"),
    )
  })
})

describe("firstDueAt", () => {
  it("resolves every clock kind to one instant and a dependency to none", () => {
    const submitted = Date.parse("2026-10-02T20:00:00Z")
    expect(firstDueAt({ kind: "at", atMs: 42 }, submitted)).toBe(42)
    expect(firstDueAt({ kind: "delay", delayMs: 3600_000 }, submitted)).toBe(
      submitted + 3600_000,
    )
    expect(firstDueAt({ kind: "cron", expr: "0 23 * * *" }, submitted)).toBe(
      Date.parse("2026-10-02T23:00:00Z"),
    )
    expect(
      firstDueAt(
        { kind: "after", entryId: "a", requireSuccess: true },
        submitted,
      ),
    ).toBeUndefined()
  })
})

describe("validateEntries — the submit gate", () => {
  const at: Trigger = { at: "2026-10-02T23:00:00Z" }

  it("passes a sound chain", () => {
    expect(
      validateEntries(
        [
          { id: "a", trigger: at },
          { id: "b", trigger: { after: "a", require: "success" } },
        ],
        NOW,
      ),
    ).toEqual([])
  })

  it("catches an after: naming no Entry", () => {
    const errs = validateEntries(
      [
        { id: "a", trigger: at },
        { id: "b", trigger: { after: "typo" } },
      ],
      NOW,
    )
    expect(errs).toHaveLength(1)
    expect(errs[0]).toContain("names no Entry")
  })

  it("catches a cycle", () => {
    const errs = validateEntries(
      [
        { id: "a", trigger: { after: "b" } },
        { id: "b", trigger: { after: "a" } },
      ],
      NOW,
    )
    expect(errs.some((e) => e.startsWith("cycle:"))).toBe(true)
  })

  it("reports the cycle that strands an Entry downstream of it", () => {
    // An Entry has exactly one edge, so 'unreachable from a clock' always
    // means 'leads into a cycle' — 'c' is stranded, and the cycle is what the
    // developer has to fix.
    const errs = validateEntries(
      [
        { id: "a", trigger: { after: "b" } },
        { id: "b", trigger: { after: "a" } },
        { id: "c", trigger: { after: "b" } },
      ],
      NOW,
    )
    expect(errs.some((e) => e.startsWith("cycle:"))).toBe(true)
  })

  it("catches a duplicate id", () => {
    const errs = validateEntries(
      [
        { id: "a", trigger: at },
        { id: "a", trigger: at },
      ],
      NOW,
    )
    expect(errs).toEqual(["duplicate entry id 'a'"])
  })

  it("refuses an id that would be read as a delay", () => {
    const errs = validateEntries([{ id: "2h", trigger: at }], NOW)
    expect(errs[0]).toContain("shaped like a duration")
  })

  it("refuses a cron that would never come round", () => {
    // It parses, it is a clock, and every graph rule passes — but its next
    // occurrence is past the search horizon, so it would be stored with no
    // not_before and silently never fire. Submit is the only place to catch it.
    const errs = validateEntries(
      [{ id: "leap", trigger: { cron: "0 0 29 2 *" } }],
      NOW,
    )
    expect(errs).toHaveLength(1)
    expect(errs[0]).toContain("no occurrence in the next year")

    // An impossible date, which no horizon would ever reach.
    expect(
      validateEntries(
        [{ id: "never", trigger: { cron: "0 0 30 2 *" } }],
        NOW,
      )[0],
    ).toContain("would never fire")
  })

  it("refuses depending on a recurring Entry", () => {
    const errs = validateEntries(
      [
        { id: "a", trigger: { cron: "0 23 * * *" } },
        { id: "b", trigger: { after: "a" } },
      ],
      NOW,
    )
    expect(errs[0]).toContain("recurring (cron) Entry")
  })
})

describe("decide — clock Entries", () => {
  it("launches once the instant has passed and not before", () => {
    const due = entry({ entryId: "a", notBefore: "2026-10-02T23:00:00Z" })
    expect(decide(tick({ entries: [due] }))).toEqual([
      { kind: "launch", scheduleId: "nightly", entryId: "a" },
    ])
    const later = entry({ entryId: "a", notBefore: "2026-10-03T23:00:00Z" })
    expect(decide(tick({ entries: [later] }))).toEqual([])
  })

  it("never fires a cancelled Entry", () => {
    const cancelled = entry({
      entryId: "a",
      state: "cancelled",
      notBefore: "2026-10-02T23:00:00Z",
    })
    expect(decide(tick({ entries: [cancelled] }))).toEqual([])
  })

  it("never fires an Entry already launched or settled", () => {
    const states = ["launched", "done", "failed"] as const
    for (const state of states) {
      const e = entry({
        entryId: "a",
        state,
        notBefore: "2026-10-02T23:00:00Z",
        runId: "r1",
        launchedAt: "2026-10-02T23:00:00Z",
      })
      const out = decide(
        tick({ entries: [e], runs: [{ runId: "r1", running: true }] }),
      )
      expect(out.filter((d) => d.kind === "launch")).toEqual([])
    }
  })
})

describe("decide — settling a launched Entry", () => {
  const launched = (over: Partial<TickEntry> = {}) =>
    entry({
      entryId: "a",
      state: "launched",
      runId: "r1",
      launchedAt: "2026-10-02T23:00:00Z",
      ...over,
    })

  it("exit 0 is success", () => {
    const out = decide(
      tick({
        entries: [launched()],
        runs: [{ runId: "r1", running: false, exitCode: 0 }],
      }),
    )
    expect(out).toEqual([
      {
        kind: "settle",
        scheduleId: "nightly",
        entryId: "a",
        outcome: "success",
        reason: "Run r1 exited 0",
      },
    ])
  })

  it("a non-zero exit is failure", () => {
    const out = decide(
      tick({
        entries: [launched()],
        runs: [{ runId: "r1", running: false, exitCode: 7 }],
      }),
    )
    expect(out[0]).toMatchObject({ kind: "settle", outcome: "failure" })
  })

  it("an ABSENT exit code is failure, not 'keep waiting'", () => {
    const out = decide(
      tick({ entries: [launched()], runs: [{ runId: "r1", running: false }] }),
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ kind: "settle", outcome: "failure" })
    expect((out[0] as { reason: string }).reason).toContain(
      "without recording an exit code",
    )
  })

  it("leaves a live Run alone until its timeout plus grace", () => {
    const running: RunFact = { runId: "r1", running: true }
    expect(decide(tick({ entries: [launched()], runs: [running] }))).toEqual([])
    const overran = decide(
      tick({
        entries: [launched({ timeoutHours: 4 })],
        runs: [running],
        nowMs: Date.parse("2026-10-03T03:31:00Z"),
      }),
    )
    expect(overran[0]).toMatchObject({ kind: "settle", outcome: "failure" })
  })
})

describe("decide — the staleness guard", () => {
  it("waits out the grace window when no history row exists yet", () => {
    const e = entry({
      entryId: "a",
      state: "launched",
      runId: "r1",
      launchedAt: "2026-10-02T23:03:00Z",
    })
    expect(decide(tick({ entries: [e], runs: [] }))).toEqual([])
  })

  it("fails the Entry once the row has not appeared in time", () => {
    const e = entry({
      entryId: "a",
      state: "launched",
      runId: "r1",
      launchedAt: "2026-10-02T22:50:00Z",
    })
    const out = decide(tick({ entries: [e], runs: [] }))
    expect(out[0]).toMatchObject({ kind: "settle", outcome: "failure" })
    expect((out[0] as { reason: string }).reason).toContain("no history row")
  })
})

describe("decide — dependency edges", () => {
  const a = (over: Partial<TickEntry> = {}) =>
    entry({
      entryId: "a",
      state: "launched",
      runId: "r1",
      launchedAt: "2026-10-02T23:00:00Z",
      ...over,
    })
  const b = (trigger: Trigger) => entry({ entryId: "b", trigger })

  it("fires a dependant on the same tick its dependency settled", () => {
    const out = decide(
      tick({
        entries: [a(), b({ after: "a", require: "success" })],
        runs: [{ runId: "r1", running: false, exitCode: 0 }],
      }),
    )
    expect(out).toContainEqual({
      kind: "launch",
      scheduleId: "nightly",
      entryId: "b",
    })
  })

  it("reports a blocked dependant rather than leaving it pending forever", () => {
    const out = decide(
      tick({
        entries: [a(), b({ after: "a", require: "success" })],
        runs: [{ runId: "r1", running: false, exitCode: 7 }],
      }),
    )
    expect(out.filter((d) => d.kind === "launch")).toEqual([])
    expect(out).toContainEqual({
      kind: "settle",
      scheduleId: "nightly",
      entryId: "b",
      outcome: "failure",
      reason: "dependency 'a' did not succeed",
    })
  })

  it("fires a plain 'finished' dependant whatever the outcome", () => {
    const out = decide(
      tick({
        entries: [a(), b({ after: "a" })],
        runs: [{ runId: "r1", running: false, exitCode: 7 }],
      }),
    )
    expect(out).toContainEqual({
      kind: "launch",
      scheduleId: "nightly",
      entryId: "b",
    })
  })

  // "Finished" means the dependency reached an outcome, not that it reported
  // one. A reclaimed or crashed VM records no exit code, which settles the
  // dependency `failure` — and a dependant that only asked for `after` must
  // still fire, or losing a VM would strand the rest of the Schedule.
  it("fires a plain 'finished' dependant when the dependency recorded NO exit code", () => {
    const out = decide(
      tick({
        entries: [a(), b({ after: "a" })],
        runs: [{ runId: "r1", running: false }],
      }),
    )
    expect(out).toContainEqual({
      kind: "launch",
      scheduleId: "nightly",
      entryId: "b",
    })
    expect(out).toContainEqual({
      kind: "settle",
      scheduleId: "nightly",
      entryId: "a",
      outcome: "failure",
      reason: "Run r1 ended without recording an exit code",
    })
  })

  it("holds back a 'succeeds' dependant on that same missing exit code", () => {
    const out = decide(
      tick({
        entries: [a(), b({ after: "a", require: "success" })],
        runs: [{ runId: "r1", running: false }],
      }),
    )
    expect(out.filter((d) => d.kind === "launch")).toEqual([])
    expect(out).toContainEqual({
      kind: "settle",
      scheduleId: "nightly",
      entryId: "b",
      outcome: "failure",
      reason: "dependency 'a' did not succeed",
    })
  })

  it("collapses a whole blocked chain in one pass", () => {
    const out = decide(
      tick({
        entries: [
          a(),
          b({ after: "a", require: "success" }),
          entry({ entryId: "c", trigger: { after: "b", require: "success" } }),
        ],
        runs: [{ runId: "r1", running: false, exitCode: 7 }],
      }),
    )
    const settled = out.filter((d) => d.kind === "settle").map((d) => d.entryId)
    expect(settled.sort()).toEqual(["a", "b", "c"])
  })

  it("keeps edges inside their own Schedule", () => {
    const out = decide(
      tick({
        entries: [
          a(),
          { ...b({ after: "a", require: "success" }), scheduleId: "other" },
        ],
        runs: [{ runId: "r1", running: false, exitCode: 0 }],
      }),
    )
    expect(out.filter((d) => d.kind === "launch")).toEqual([])
  })
})

describe("decide — a cron Entry re-arms after each occurrence", () => {
  it("settles the occurrence and schedules the next one", () => {
    const e = entry({
      entryId: "nightly-run",
      state: "launched",
      trigger: { cron: "0 23 * * *" },
      runId: "r1",
      launchedAt: "2026-10-02T23:00:00Z",
    })
    const out = decide(
      tick({
        entries: [e],
        runs: [{ runId: "r1", running: false, exitCode: 0 }],
      }),
    )
    expect(out).toContainEqual({
      kind: "settle",
      scheduleId: "nightly",
      entryId: "nightly-run",
      outcome: "success",
      reason: "Run r1 exited 0",
    })
    expect(out).toContainEqual({
      kind: "rearm",
      scheduleId: "nightly",
      entryId: "nightly-run",
      notBeforeMs: Date.parse("2026-10-03T23:00:00Z"),
    })
  })
})
