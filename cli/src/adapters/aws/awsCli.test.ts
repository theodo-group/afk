import { describe, expect, it } from "bun:test"
import { awsErrorCode } from "./awsCli.ts"

describe("awsErrorCode", () => {
  it("lifts the code out of a real aws CLI failure", () => {
    const stderr = `
aws: [ERROR]: An error occurred (InsufficientInstanceCapacity) when calling the RunInstances operation (reached max retries: 2): There is no Spot capacity available that matches your request.`
    expect(awsErrorCode(stderr)).toBe("InsufficientInstanceCapacity")
  })

  it("handles codes carrying a dot", () => {
    expect(
      awsErrorCode(
        "An error occurred (InvalidInstanceID.NotFound) when calling the DescribeInstances operation",
      ),
    ).toBe("InvalidInstanceID.NotFound")
  })

  it("is undefined when stderr names no code", () => {
    expect(awsErrorCode("Unable to locate credentials")).toBeUndefined()
    expect(awsErrorCode("")).toBeUndefined()
  })
})
