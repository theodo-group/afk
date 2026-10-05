import { describe, it, expect } from "bun:test"
import { Cause, Exit, FiberId } from "effect"
import { exitCodeOf } from "./ExitCode.ts"

describe("exitCodeOf", () => {
  const interrupted = Exit.failCause(Cause.interrupt(FiberId.none))

  it("exits 0 on success", () => {
    expect(exitCodeOf(Exit.void, undefined)).toBe(0)
  })

  it("exits 1 on a failure", () => {
    expect(exitCodeOf(Exit.fail("boom"), undefined)).toBe(1)
  })

  it("reports a SIGTERM interruption as 143, not a success", () => {
    expect(exitCodeOf(interrupted, "SIGTERM")).toBe(143)
  })

  it("reports a Ctrl-C interruption as 130", () => {
    expect(exitCodeOf(interrupted, "SIGINT")).toBe(130)
  })
})
