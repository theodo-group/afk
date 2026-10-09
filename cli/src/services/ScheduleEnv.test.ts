import { describe, expect, it } from "bun:test"
import {
  missingRefs,
  plainEntryAllowed,
  resolveScheduleEnv,
} from "./ScheduleEnv.ts"
import type { EnvEntry } from "../schema/Config.ts"

const ref = (name: string, secretName: string): EnvEntry => ({
  kind: "secret",
  name,
  secretName,
})
const plain = (name: string, value: string): EnvEntry => ({
  kind: "plain",
  name,
  value,
})

/** The names the submitter's SSM already holds, in the common case. */
const stored = ["gitlab-token-jjauzion", "claude-oauth-jjauzion"]

describe("which plain names a Schedule may carry", () => {
  it("admits AFK_SKIP_SETUP, which is a switch and not a credential", () => {
    expect(plainEntryAllowed("AFK_SKIP_SETUP")).toBe(true)
  })

  it("admits nothing else, including other AFK_ names", () => {
    // The reason the rule is a list rather than an `AFK_*` prefix: this is
    // exactly the name a developer pastes a token into.
    expect(plainEntryAllowed("AFK_GITLAB_TOKEN")).toBe(false)
    expect(plainEntryAllowed("AFK_SKIP_SETUP_TOO")).toBe(false)
    expect(plainEntryAllowed("GITLAB_TOKEN")).toBe(false)
  })
})

describe("missingRefs", () => {
  it("names only what the store lacks", () => {
    expect(missingRefs(["a", "b", "c"], ["b"])).toEqual(["a", "c"])
  })

  it("reports a name referenced twice only once", () => {
    expect(missingRefs(["a", "a"], [])).toEqual(["a"])
  })

  it("is empty when everything resolves", () => {
    expect(missingRefs(["a"], ["a", "b"])).toEqual([])
  })
})

describe("resolving a submitter's environment for a Schedule", () => {
  it("carries references through, pairing variable to secret name", () => {
    // A swap here would hand the Run the wrong credential under the right
    // variable — which nothing downstream could detect. Hence name ≠ secretName.
    const env = [
      ref("GITLAB_TOKEN", "gitlab-token-jjauzion"),
      ref("CLAUDE_CODE_OAUTH_TOKEN", "claude-oauth-jjauzion"),
    ]
    const r = resolveScheduleEnv({ envEntries: env, storedSecretNames: stored })
    expect(r.problems).toEqual([])
    expect(r.env).toEqual(env)
  })

  it("refuses a plain value, naming the variable", () => {
    const r = resolveScheduleEnv({
      envEntries: [plain("SANTEVET_JIRA_API_TOKEN", "a-live-token")],
      storedSecretNames: stored,
    })
    expect(r.problems).toHaveLength(1)
    expect(r.problems[0]).toContain("SANTEVET_JIRA_API_TOKEN")
    expect(r.problems[0]).toContain("afk secrets put")
  })

  it("never echoes the plain value it refuses", () => {
    const r = resolveScheduleEnv({
      envEntries: [plain("SOME_TOKEN", "s3cr3t-value")],
      storedSecretNames: [],
    })
    expect(r.problems.join("\n")).not.toContain("s3cr3t-value")
  })

  it("admits AFK_SKIP_SETUP alongside references", () => {
    const env = [
      ref("GITLAB_TOKEN", "gitlab-token-jjauzion"),
      plain("AFK_SKIP_SETUP", "1"),
    ]
    const r = resolveScheduleEnv({ envEntries: env, storedSecretNames: stored })
    expect(r.problems).toEqual([])
    expect(r.env).toEqual(env)
  })

  it("reports every problem at once, not the first", () => {
    // A developer fixing their .afk.env should not discover it one submit at
    // a time: two plain values and two unmet references is four lines.
    const r = resolveScheduleEnv({
      envEntries: [
        plain("SANTEVET_EMAIL_API", "x"),
        plain("SANTEVET_JIRA_API_TOKEN", "y"),
        ref("GITLAB_TOKEN", "gitlab-token-someone-else"),
        ref("CLAUDE_CODE_OAUTH_TOKEN", "claude-oauth-someone-else"),
      ],
      storedSecretNames: stored,
    })
    expect(r.problems).toHaveLength(4)
    expect(r.problems.join("\n")).toContain("gitlab-token-someone-else")
    expect(r.problems.join("\n")).toContain("claude-oauth-someone-else")
  })

  it("treats the legacy ssm: form as an ordinary reference", () => {
    // ConfigService has already turned `ssm:/afk/secrets/x` into this shape,
    // so nothing here needs to know the two spellings existed.
    const r = resolveScheduleEnv({
      envEntries: [ref("GITHUB_TOKEN", "gitlab-token-jjauzion")],
      storedSecretNames: stored,
    })
    expect(r.problems).toEqual([])
  })

  it("accepts an empty environment", () => {
    const r = resolveScheduleEnv({ envEntries: [], storedSecretNames: [] })
    expect(r.problems).toEqual([])
    expect(r.env).toEqual([])
  })
})
