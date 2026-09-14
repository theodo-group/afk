import { describe, expect, it } from "bun:test"
import { ownerTagValues, stableOwnerId } from "./OwnerId.ts"

describe("stableOwnerId", () => {
  it("drops the session name an assumed role carries", () => {
    expect(
      stableOwnerId("AROA2MRQMS6V55YGVGEQU:botocore-session-1789380071"),
    ).toBe("AROA2MRQMS6V55YGVGEQU")
  })

  it("is unchanged across two refreshes of the same role", () => {
    const a = stableOwnerId("AROAEXAMPLE:botocore-session-1")
    const b = stableOwnerId("AROAEXAMPLE:botocore-session-2")
    expect(a).toBe(b)
  })

  it("leaves an IAM user's id alone — it has no session half", () => {
    expect(stableOwnerId("AIDAEXAMPLE")).toBe("AIDAEXAMPLE")
  })

  it("keeps only the first segment when the session name has colons", () => {
    expect(stableOwnerId("AROAEXAMPLE:a:b")).toBe("AROAEXAMPLE")
  })
})

describe("ownerTagValues", () => {
  it("matches Runs tagged the new way and the legacy way", () => {
    expect(ownerTagValues("AROAEXAMPLE:botocore-session-1")).toEqual([
      "AROAEXAMPLE",
      "AROAEXAMPLE:*",
    ])
  })
})
