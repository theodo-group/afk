import { describe, it, expect } from "bun:test"
import type { HistoryRow } from "../../services/backend/RunHistory.ts"
import { newestFirst } from "./AwsRunHistory.ts"

const row = (runId: string, startedAt: string): HistoryRow => ({
  runId,
  owner: "",
  repo: "",
  branch: "",
  sha: "",
  image: "",
  resourceId: "",
  status: "STOPPED",
  startedAt,
  stoppedAt: undefined,
  exitCode: undefined,
  timeoutHours: 0,
})

describe("newestFirst", () => {
  const scanned = [
    row("old", "2026-09-01T00:00:00Z"),
    row("newest", "2026-10-03T16:26:20Z"),
    row("middle", "2026-09-20T00:00:00Z"),
  ]

  it("keeps the newest Runs when capped, whatever order the Scan returned", () => {
    expect(newestFirst(scanned, 2).map((r) => r.runId)).toEqual([
      "newest",
      "middle",
    ])
  })

  it("returns every Run, newest first, without a limit", () => {
    expect(newestFirst(scanned, undefined).map((r) => r.runId)).toEqual([
      "newest",
      "middle",
      "old",
    ])
  })
})
