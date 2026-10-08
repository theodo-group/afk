import { describe, it, expect } from "bun:test"
import { Either } from "effect"
import {
  instanceArn,
  ownerKey,
  personalSecretName,
  requireNamedOwner,
  runSecretName,
  runSecretTags,
} from "./AwsPersonalSecrets.ts"

const ALICE = "AROAEXAMPLEID:alice"
const BOB = "AROAEXAMPLEID:bob"

describe("AWS personal secret naming", () => {
  it("keeps two developers on one shared role apart", () => {
    expect(ownerKey(ALICE)).not.toBe(ownerKey(BOB))
  })

  it("keeps personal secrets out of the team secret path", () => {
    expect(personalSecretName(undefined, ALICE, "claude-oauth")).toBe(
      `/afk/personal/${ownerKey(ALICE)}/claude-oauth`,
    )
    expect(personalSecretName(undefined, ALICE, "x")).not.toStartWith(
      "/afk/secrets/",
    )
  })

  it("follows the configured resource prefix", () => {
    expect(runSecretName("cda", "run-1", "claude-oauth")).toBe(
      "/cda/runs/run-1/claude-oauth",
    )
  })

  it("tags a Run's copy with the one instance allowed to read it", () => {
    const arn = instanceArn("eu-west-3", "123456789012", "i-0abc")
    expect(arn).toBe("arn:aws:ec2:eu-west-3:123456789012:instance/i-0abc")
    expect(runSecretTags(ALICE, arn)).toEqual([
      { key: "afk:owner", value: ALICE },
      { key: "afk:instance", value: arn },
    ])
  })
})

describe("requireNamedOwner", () => {
  it("accepts a named session and an IAM user", () => {
    expect(Either.isRight(requireNamedOwner(ALICE))).toBe(true)
    expect(Either.isRight(requireNamedOwner("AIDAEXAMPLEUSER"))).toBe(true)
  })

  it("refuses a session AWS named itself", () => {
    expect(
      Either.isLeft(
        requireNamedOwner("AROAEXAMPLEID:botocore-session-1712345"),
      ),
    ).toBe(true)
  })
})
