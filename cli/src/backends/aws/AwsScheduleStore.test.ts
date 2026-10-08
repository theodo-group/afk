import { describe, expect, it } from "bun:test"
import { entryFromItem, itemFromEntry } from "./AwsScheduleStore.ts"
import type { StoredEntry } from "../../services/backend/ScheduleStore.ts"

/**
 * The row mapping is the one place an Entry can go missing without an error:
 * `entryFromItem` returns null for anything it cannot read, and the caller
 * filters those out silently. A round trip is what proves the two halves agree
 * on all sixteen fields — including `trigger`, which crosses as a JSON string
 * because DynamoDB maps are outside the CLI's `AttrValue`.
 */
const full: StoredEntry = {
  scheduleId: "nightly-specs",
  entryId: "plan-contrat",
  state: "launched",
  trigger: { after: "spec-contrat", require: "success" },
  ref: "docs/contrat-spec",
  command:
    "node scripts/afk-claude/cli.ts --skip-model-check '/create-spec contrat'",
  image: "1234.dkr.ecr.eu-west-1.amazonaws.com/afk/cip:main-abc123def456",
  owner: "AROAEXAMPLE:jjauzion",
  timeoutHours: 24,
  onDemand: true,
  instanceType: "m6a.2xlarge",
  launchAttempts: 0,
  submittedAt: "2026-10-02T20:00:00.000Z",
  notBefore: "2026-10-02T23:00:00.000Z",
  runId: "4c4ecbae-375e-4f1e-9b1a-000000000001",
  launchedAt: "2026-10-02T23:00:05.000Z",
  settledAt: "2026-10-03T01:00:00.000Z",
  outcome: "failure",
  reason: "Run 4c4ecbae exited 7",
}

/** Only what submit writes: every optional absent. */
const minimal: StoredEntry = {
  scheduleId: "nightly-specs",
  entryId: "spec-contrat",
  state: "pending",
  trigger: { at: "2026-10-02T23:00:00Z" },
  ref: "docs/contrat-spec",
  command: "echo hi",
  image: "1234.dkr.ecr.eu-west-1.amazonaws.com/afk/cip:main-abc123def456",
  owner: "AROAEXAMPLE:jjauzion",
  timeoutHours: 4,
  onDemand: false,
  launchAttempts: 0,
  submittedAt: "2026-10-02T20:00:00.000Z",
}

describe("the schedule row mapping", () => {
  it("round-trips a fully-populated Entry", () => {
    expect(entryFromItem(itemFromEntry(full))).toEqual(full)
  })

  it("round-trips an Entry with every optional absent, adding no keys", () => {
    const back = entryFromItem(itemFromEntry(minimal))
    expect(back).toEqual(minimal)
    expect(Object.keys(back!).sort()).toEqual(Object.keys(minimal).sort())
  })

  it("round-trips each trigger kind through the JSON string hop", () => {
    const triggers = [
      { at: "2026-10-02T23:00:00Z" },
      { cron: "0 23 * * *" },
      { after: "2h" },
      { after: "spec-contrat" },
      { after: "spec-contrat", require: "success" as const },
    ]
    for (const trigger of triggers) {
      expect(
        entryFromItem(itemFromEntry({ ...minimal, trigger }))?.trigger,
      ).toEqual(trigger)
    }
  })

  it("carries the launch-retry bookkeeping both ways", () => {
    const refused = {
      ...full,
      state: "pending" as const,
      launchAttempts: 2,
      lastError: "InsufficientInstanceCapacity",
    }
    const back = entryFromItem(itemFromEntry(refused))
    expect(back?.launchAttempts).toBe(2)
    expect(back?.lastError).toBe("InsufficientInstanceCapacity")
    expect(back?.state).toBe("pending")
  })

  it("reads a row written before launch_attempts existed as zero attempts", () => {
    const { launch_attempts: _dropped, ...legacy } = itemFromEntry(full)
    const back = entryFromItem(legacy)
    expect(back?.launchAttempts).toBe(0)
    expect(back?.lastError).toBeUndefined()
  })

  it("drops a row it cannot read rather than guessing at it", () => {
    expect(entryFromItem({})).toBeNull()
    // A trigger that is no longer valid JSON, or no longer a Trigger.
    expect(
      entryFromItem({ ...itemFromEntry(minimal), trigger: { S: "{not json" } }),
    ).toBeNull()
    expect(
      entryFromItem({
        ...itemFromEntry(minimal),
        trigger: { S: '{"nope":1}' },
      }),
    ).toBeNull()
    // An unknown state is not silently coerced to pending.
    expect(
      entryFromItem({ ...itemFromEntry(minimal), state: { S: "hibernating" } }),
    ).toBeNull()
  })
})
