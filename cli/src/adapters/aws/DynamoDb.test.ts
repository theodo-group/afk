import { describe, expect, it } from "bun:test"
import { attributeMapArgs } from "./DynamoDb.ts"

describe("attributeMapArgs", () => {
  it("passes a non-empty map through as its flag", () => {
    expect(
      attributeMapArgs("--expression-attribute-names", { "#st": "state" }),
    ).toEqual(["--expression-attribute-names", '{"#st":"state"}'])
  })

  it("omits an empty map rather than sending it", () => {
    // DynamoDB rejects an empty map outright. That once crashed every tick
    // that tried to record a refused launch for a retry — the update named no
    // attributes — and hid the launch error behind it.
    expect(attributeMapArgs("--expression-attribute-names", {})).toEqual([])
  })

  it("omits an absent map", () => {
    expect(
      attributeMapArgs("--expression-attribute-values", undefined),
    ).toEqual([])
  })
})
