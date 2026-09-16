import { describe, expect, it } from "bun:test"
import {
  anonymousOwnerWarning,
  ownerTagValues,
  resolveOwner,
  sessionNameOf,
  stableOwnerId,
} from "./OwnerId.ts"

describe("resolveOwner", () => {
  it("keeps the session name, so an Owner is a person and not a role", () => {
    expect(resolveOwner("AROA2MRQMS6V55YGVGEQU:alice.martin")).toEqual({
      id: "AROA2MRQMS6V55YGVGEQU:alice.martin",
      anonymous: false,
    })
  })

  it("is byte-identical to the userid the developer policy compares against", () => {
    const userId = "AROA2MRQMS6V55YGVGEQU:alice.martin"
    expect(resolveOwner(userId).id).toBe(userId)
  })

  it("tells two developers on the same role apart", () => {
    const alice = resolveOwner("AROAEXAMPLE:alice.martin").id
    const bob = resolveOwner("AROAEXAMPLE:bob.dupont").id
    expect(alice).not.toBe(bob)
  })

  it("is unchanged across two refreshes of a named session", () => {
    const first = resolveOwner("AROAEXAMPLE:alice.martin").id
    const second = resolveOwner("AROAEXAMPLE:alice.martin").id
    expect(first).toBe(second)
  })

  it("leaves an IAM user alone — there is no session half to name", () => {
    expect(resolveOwner("AIDAEXAMPLE")).toEqual({
      id: "AIDAEXAMPLE",
      anonymous: false,
    })
  })

  it("falls back to the role for the session name the aws CLI mints per refresh", () => {
    expect(
      resolveOwner("AROA2MRQMS6V55YGVGEQU:botocore-session-1789562608"),
    ).toEqual({ id: "AROA2MRQMS6V55YGVGEQU", anonymous: true })
  })

  it("falls back for a bare epoch session name", () => {
    expect(resolveOwner("AROAEXAMPLE:1789562608").anonymous).toBe(true)
  })

  it("falls back for an AWS SDK default session name", () => {
    expect(resolveOwner("AROAEXAMPLE:aws-sdk-js-1789562608").anonymous).toBe(
      true,
    )
  })

  it("falls back for an empty session name", () => {
    expect(resolveOwner("AROAEXAMPLE:").anonymous).toBe(true)
  })

  it("keeps the fallback stable across two refreshes, as the tag must be", () => {
    const first = resolveOwner("AROAEXAMPLE:botocore-session-1").id
    const second = resolveOwner("AROAEXAMPLE:botocore-session-2").id
    expect(first).toBe(second)
  })

  it("accepts an EC2 instance profile's session name", () => {
    expect(resolveOwner("AROAEXAMPLE:i-0abc123def456").anonymous).toBe(false)
  })

  it("accepts an SSO session name, which Identity Center sets to the user", () => {
    expect(resolveOwner("AROAEXAMPLE:alice.martin@theodo.com").anonymous).toBe(
      false,
    )
  })

  it("accepts a session name CI chose", () => {
    expect(resolveOwner("AROAEXAMPLE:GitHubActions").anonymous).toBe(false)
  })

  it("accepts an ECS task role's task id", () => {
    expect(
      resolveOwner("AROAEXAMPLE:1a2b3c4d5e6f4a7b8c9d0e1f2a3b4c5d").anonymous,
    ).toBe(false)
  })

  it("keeps a session name that itself contains colons", () => {
    expect(resolveOwner("AROAEXAMPLE:a:b").id).toBe("AROAEXAMPLE:a:b")
  })
})

describe("anonymousOwnerWarning", () => {
  it("quotes the session name, so the developer recognises it", () => {
    expect(
      anonymousOwnerWarning("AROAEXAMPLE:botocore-session-1789562608"),
    ).toContain("botocore-session-1789562608")
  })

  it("carries the command that fixes it", () => {
    expect(anonymousOwnerWarning("AROAEXAMPLE:botocore-session-1")).toContain(
      "role_session_name",
    )
  })
})

describe("ownerTagValues", () => {
  it("matches exactly the value afk run writes", () => {
    expect(ownerTagValues("AROAEXAMPLE:alice.martin")).toEqual([
      "AROAEXAMPLE:alice.martin",
    ])
  })

  it("no longer matches every Run the shared role launched", () => {
    expect(ownerTagValues("AROAEXAMPLE:alice.martin")).not.toContain(
      "AROAEXAMPLE:*",
    )
  })
})

describe("sessionNameOf", () => {
  it("is the half after the principal id", () => {
    expect(sessionNameOf("AROAEXAMPLE:alice.martin")).toBe("alice.martin")
  })

  it("is undefined for an IAM user", () => {
    expect(sessionNameOf("AIDAEXAMPLE")).toBeUndefined()
  })
})

describe("stableOwnerId", () => {
  it("drops the session name, which is what a legacy afk:owner tag holds", () => {
    expect(
      stableOwnerId("AROA2MRQMS6V55YGVGEQU:botocore-session-1789380071"),
    ).toBe("AROA2MRQMS6V55YGVGEQU")
  })

  it("leaves an IAM user's id alone — it has no session half", () => {
    expect(stableOwnerId("AIDAEXAMPLE")).toBe("AIDAEXAMPLE")
  })
})
