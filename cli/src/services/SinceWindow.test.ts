import { describe, it, expect } from "bun:test"
import { Duration, Either } from "effect"
import { parseSince } from "./SinceWindow.ts"

describe("parseSince", () => {
  it("parses days", () => {
    const r = parseSince("7d")
    expect(Either.isRight(r)).toBe(true)
    if (Either.isRight(r)) {
      expect(Duration.toSeconds(r.right)).toBe(Duration.toSeconds(Duration.days(7)))
    }
  })

  it("parses hours", () => {
    const r = parseSince("24h")
    expect(Either.isRight(r)).toBe(true)
    if (Either.isRight(r)) {
      expect(Duration.toSeconds(r.right)).toBe(Duration.toSeconds(Duration.hours(24)))
    }
  })

  it("parses minutes", () => {
    const r = parseSince("30m")
    expect(Either.isRight(r)).toBe(true)
    if (Either.isRight(r)) {
      expect(Duration.toSeconds(r.right)).toBe(Duration.toSeconds(Duration.minutes(30)))
    }
  })

  it("parses seconds", () => {
    const r = parseSince("10s")
    expect(Either.isRight(r)).toBe(true)
    if (Either.isRight(r)) {
      expect(Duration.toSeconds(r.right)).toBe(Duration.toSeconds(Duration.seconds(10)))
    }
  })

  it.each(["7x", "abc", ""])("rejects %p with a UserError", (token) => {
    const r = parseSince(token)
    expect(Either.isLeft(r)).toBe(true)
    if (Either.isLeft(r)) {
      expect(r.left._tag).toBe("UserError")
    }
  })
})
