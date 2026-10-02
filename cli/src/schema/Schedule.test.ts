import { describe, expect, it } from "bun:test"
import { Either, Schema } from "effect"
import { parse as parseYaml } from "yaml"
import { ScheduleFile } from "./Schedule.ts"
import { validateEntries } from "../services/Triggers.ts"

const decode = Schema.decodeUnknownEither(ScheduleFile)

/** The format as documented, verbatim. If this stops decoding, the docs lie. */
const EXAMPLE = `
schedule: nightly-specs
entries:
  - id: spec-contrat
    ref: docs/contrat-spec
    on_demand: true
    timeout_hours: 24
    command: "node scripts/afk-claude/cli.ts --skip-model-check '/create-spec contrat'"
    trigger: { at: "2026-10-02T23:00:00Z" }
  - id: plan-contrat
    ref: docs/contrat-spec
    command: "node scripts/afk-claude/cli.ts --skip-model-check '/create-migration-plan contrat'"
    trigger: { after: spec-contrat, require: success }
`

describe("the Schedule file format", () => {
  const decoded = decode(parseYaml(EXAMPLE) as unknown)

  it("decodes the documented example", () => {
    expect(Either.isRight(decoded)).toBe(true)
  })

  it("maps the file's snake_case onto the house camelCase", () => {
    if (Either.isLeft(decoded)) throw new Error("example did not decode")
    const [first, second] = decoded.right.entries
    expect(first).toMatchObject({
      id: "spec-contrat",
      ref: "docs/contrat-spec",
      onDemand: true,
      timeoutHours: 24,
      trigger: { at: "2026-10-02T23:00:00Z" },
    })
    // The command survives verbatim, inner quoting included: the VM joins argv
    // with spaces and hands the result to `sh -c`.
    expect(first?.command).toBe(
      "node scripts/afk-claude/cli.ts --skip-model-check '/create-spec contrat'",
    )
    expect(second?.trigger).toEqual({
      after: "spec-contrat",
      require: "success",
    })
    // Omitted knobs stay absent, so submit can fall back to the config default.
    expect(second?.timeoutHours).toBeUndefined()
    expect(second?.onDemand).toBeUndefined()
  })

  it("is a graph the submit gate accepts", () => {
    if (Either.isLeft(decoded)) throw new Error("example did not decode")
    expect(
      validateEntries(
        decoded.right.entries.map((e) => ({ id: e.id, trigger: e.trigger })),
        Date.parse("2026-10-01T00:00:00Z"),
      ),
    ).toEqual([])
  })

  it("refuses a file with no entries and one with no schedule id", () => {
    expect(Either.isLeft(decode({ schedule: "x", entries: [] }))).toBe(true)
    expect(Either.isLeft(decode({ entries: [] }))).toBe(true)
  })

  it("refuses an Entry missing a command or a trigger", () => {
    expect(
      Either.isLeft(
        decode({ schedule: "x", entries: [{ id: "a", ref: "main" }] }),
      ),
    ).toBe(true)
  })
})
