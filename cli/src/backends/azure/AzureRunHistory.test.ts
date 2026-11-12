import { describe, expect, it } from "bun:test"
import { DateTime } from "effect"
import { historyFilter, rowFromEntity } from "./AzureRunHistory.ts"

describe("historyFilter", () => {
  it("scopes to the runs partition and escapes quotes", () => {
    expect(historyFilter({ owner: "o'brien@acme.com" })).toBe(
      "PartitionKey eq 'runs' and owner eq 'o''brien@acme.com'",
    )
  })

  it("bounds by start time", () => {
    const since = DateTime.unsafeMake("2026-11-01T00:00:00Z")
    expect(historyFilter({ since })).toBe(
      "PartitionKey eq 'runs' and started_at ge '2026-11-01T00:00:00.000Z'",
    )
  })
})

describe("rowFromEntity", () => {
  it("reads the string-typed row the VM and the CLI write", () => {
    const row = rowFromEntity({
      PartitionKey: "runs",
      RowKey: "r1",
      run_id: "r1",
      status: "failed",
      owner: "dev@acme.com",
      exit_code: "2",
      timeout_hours: "4",
      vm_name: "afk-widget-r1",
    })
    expect(row?.status).toBe("STOPPED")
    expect(row?.exitCode).toBe(2)
    expect(row?.timeoutHours).toBe(4)
    expect(row?.resourceId).toBe("afk-widget-r1")
  })

  it("reads an absent exit code as absent, never as 0", () => {
    expect(
      rowFromEntity({ RowKey: "r1", status: "stopped" })?.exitCode,
    ).toBeUndefined()
  })
})
