import { describe, expect, it } from "bun:test"
import { tagOf } from "./BuildService.ts"

describe("tagOf", () => {
  it("reads the tag off a registry-qualified image", () => {
    expect(
      tagOf("111122223333.dkr.ecr.eu-west-1.amazonaws.com/afk/demo:main-abc"),
    ).toBe("main-abc")
  })

  it("is not fooled by a port in the registry host", () => {
    expect(tagOf("localhost:5000/afk/demo")).toBe("")
    expect(tagOf("localhost:5000/afk/demo:v2")).toBe("v2")
  })

  it("returns empty for an untagged reference", () => {
    expect(tagOf("afk/demo")).toBe("")
  })
})
