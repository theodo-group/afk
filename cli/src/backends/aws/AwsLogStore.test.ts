import { describe, it, expect } from "bun:test"
import { formatEvents, startTimeMs } from "./AwsLogStore.ts"

describe("startTimeMs", () => {
  const now = Date.parse("2026-10-05T12:00:00Z")

  it("reads a duration back from now", () => {
    expect(startTimeMs("1h", now)).toBe(Date.parse("2026-10-05T11:00:00Z"))
    expect(startTimeMs("30d", now)).toBe(Date.parse("2026-09-05T12:00:00Z"))
  })

  it("reads an absolute timestamp, in the tail format the console resumes from", () => {
    expect(startTimeMs("2026-10-04T17:25:54.700000+00:00", now)).toBe(
      Date.parse("2026-10-04T17:25:54.700Z"),
    )
  })

  it("rejects anything else", () => {
    expect(startTimeMs("yesterday", now)).toBeUndefined()
  })
})

describe("formatEvents", () => {
  it("prints aws logs tail's lines, every stream merged in time order", () => {
    const lines = formatEvents([
      {
        stream: "r1/agent",
        timestamp: Date.parse("2026-10-04T17:26:00Z"),
        message: "second",
      },
      {
        stream: "r1/db",
        timestamp: Date.parse("2026-10-04T17:25:54.7Z"),
        message: "first",
      },
    ])
    expect(lines).toBe(
      "2026-10-04T17:25:54.700000+00:00 r1/db first\n" +
        "2026-10-04T17:26:00.000000+00:00 r1/agent second",
    )
  })
})
