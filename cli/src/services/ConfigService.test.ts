import { describe, it, expect } from "bun:test"
import { parseEnvLine } from "./ConfigService.ts"

describe("parseEnvLine — secret references", () => {
  it("reads `secret:<name>` as a team secret", () => {
    expect(
      parseEnvLine("GITLAB_TOKEN=secret:gitlab-token", "/afk/secrets"),
    ).toEqual({
      kind: "secret",
      name: "GITLAB_TOKEN",
      secretName: "gitlab-token",
      scope: "team",
    })
  })

  it("reads `personal-secret:<name>` as the launching Owner's own secret", () => {
    expect(
      parseEnvLine(
        "CLAUDE_CODE_OAUTH_TOKEN=personal-secret:claude-oauth",
        "/afk/secrets",
      ),
    ).toEqual({
      kind: "secret",
      name: "CLAUDE_CODE_OAUTH_TOKEN",
      secretName: "claude-oauth",
      scope: "personal",
    })
  })

  it("still reads the legacy `ssm:` form as a team secret", () => {
    expect(
      parseEnvLine("T=ssm:/afk/secrets/token", "/afk/secrets"),
    ).toMatchObject({
      secretName: "token",
      scope: "team",
    })
  })

  it("leaves a plain value alone", () => {
    expect(parseEnvLine("MODE=personal", "/afk/secrets")).toEqual({
      kind: "plain",
      name: "MODE",
      value: "personal",
    })
  })
})
