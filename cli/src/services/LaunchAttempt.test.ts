import { describe, expect, it } from "bun:test"
import { launchFailureAction, launchFailureDetail } from "./LaunchAttempt.ts"

const BUDGET = 3

describe("launchFailureAction", () => {
  const capacity = {
    _tag: "AwsError",
    code: "InsufficientInstanceCapacity",
    message: "There is no Spot capacity available",
  }

  it("retries a transient provider failure within the budget", () => {
    expect(launchFailureAction(capacity, 1, BUDGET)).toBe("retry")
    expect(launchFailureAction(capacity, 2, BUDGET)).toBe("retry")
  })

  it("gives up once the budget is spent", () => {
    expect(launchFailureAction(capacity, 3, BUDGET)).toBe("settle")
    expect(launchFailureAction(capacity, 4, BUDGET)).toBe("settle")
  })

  it("retries an error it has never heard of, rather than killing the night", () => {
    const unknown = { _tag: "AwsError", code: "SomeFutureAwsCode" }
    expect(launchFailureAction(unknown, 1, BUDGET)).toBe("retry")
  })

  it("settles a UserError at once — the developer must fix it", () => {
    const user = {
      _tag: "UserError",
      message: "ref 'nope' not found on origin",
    }
    expect(launchFailureAction(user, 1, BUDGET)).toBe("settle")
  })

  it("never retries when the budget is zero", () => {
    expect(launchFailureAction(capacity, 1, 0)).toBe("settle")
  })
})

describe("launchFailureDetail", () => {
  it("prefers the AWS error code", () => {
    expect(
      launchFailureDetail({
        _tag: "AwsError",
        code: "InsufficientInstanceCapacity",
        message: "a long\nmultiline blob",
      }),
    ).toBe("InsufficientInstanceCapacity")
  })

  it("falls back to the first line of the message", () => {
    expect(
      launchFailureDetail({
        _tag: "UserError",
        message: "\n  ref 'nope' not found on origin\nhint: push it\n",
      }),
    ).toBe("ref 'nope' not found on origin")
  })

  it("falls back to the tag when there is nothing else", () => {
    expect(launchFailureDetail({ _tag: "AwsError" })).toBe("AwsError")
  })
})
