import { describe, it, expect } from "bun:test"
import { isValidSecretName } from "../../schema/Secret.ts"
import {
  accountOfMember,
  ownerKey,
  parsePersonalSecrets,
  personalSecretId,
  personalServiceAccountEmail,
  personalServiceAccountId,
  renderPersonalSecrets,
  teamSecretsCondition,
  withSecret,
  withoutSecret,
} from "./GcpPersonalSecrets.ts"

describe("owner naming", () => {
  it("derives the same key for an account whatever its case", () => {
    expect(ownerKey("Dev@Acme.com")).toBe(ownerKey("dev@acme.com"))
  })

  it("tells two Owners apart", () => {
    expect(ownerKey("alice@acme.com")).not.toBe(ownerKey("bob@acme.com"))
  })

  it("names a service account GCP accepts", () => {
    expect(personalServiceAccountId("dev@acme.com")).toMatch(
      /^[a-z][a-z0-9-]{5,29}$/,
    )
  })

  it("puts the service account in the Run's project", () => {
    expect(personalServiceAccountEmail("acme-prod", "dev@acme.com")).toBe(
      `${personalServiceAccountId("dev@acme.com")}@acme-prod.iam.gserviceaccount.com`,
    )
  })

  it("keeps the personal secret out of the team prefix", () => {
    expect(personalSecretId("dev@acme.com")).toStartWith("afk-personal-")
    expect(personalSecretId("dev@acme.com")).not.toStartWith("afk-secret-")
  })

  it("reads the account out of an IAM member", () => {
    expect(accountOfMember("user:Dev@Acme.com")).toBe("dev@acme.com")
    expect(accountOfMember("serviceAccount:ci@p.iam.gserviceaccount.com")).toBe(
      "ci@p.iam.gserviceaccount.com",
    )
  })
})

describe("teamSecretsCondition", () => {
  it("matches team secrets only, and holds no comma", () => {
    const { expression } = teamSecretsCondition("1234")
    expect(expression).toContain('"projects/1234/secrets/afk-secret-"')
    expect(Object.values(teamSecretsCondition("1234")).join("")).not.toContain(
      ",",
    )
  })
})

describe("personal secrets payload", () => {
  it("round-trips values holding '=', newlines and unicode", () => {
    const secrets = withSecret(
      withSecret(new Map(), "claude-oauth", "sk-ant-oat01-abc=="),
      "note",
      "line one\nligne deux é",
    )
    expect(parsePersonalSecrets(renderPersonalSecrets(secrets))).toEqual(
      secrets,
    )
  })

  it("renders one line per secret, sorted, so a shell can pick one out", () => {
    const rendered = renderPersonalSecrets(
      withSecret(withSecret(new Map(), "b", "2"), "a", "1"),
    )
    expect(rendered.split("\n").filter((l) => !l.startsWith("#"))).toEqual([
      `a=${Buffer.from("1").toString("base64")}`,
      `b=${Buffer.from("2").toString("base64")}`,
      "",
    ])
  })

  it("parses the empty container as no secrets", () => {
    expect(parsePersonalSecrets(renderPersonalSecrets(new Map())).size).toBe(0)
  })

  it("overwrites and removes by name", () => {
    const one = withSecret(new Map(), "t", "old")
    expect(withSecret(one, "t", "new").get("t")).toBe("new")
    expect(withoutSecret(one, "t").has("t")).toBe(false)
  })
})

describe("isValidSecretName", () => {
  it("accepts env-file tokens and refuses anything a shell would split", () => {
    expect(isValidSecretName("claude-oauth.v2_1")).toBe(true)
    expect(isValidSecretName("a b")).toBe(false)
    expect(isValidSecretName("a=b")).toBe(false)
    expect(isValidSecretName("")).toBe(false)
  })
})
