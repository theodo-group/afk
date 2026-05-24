import { describe, it, expect } from "bun:test"
import { Either } from "effect"
import type { AfkConfig } from "../../schema/Config.ts"
import type { StartInput } from "../../services/backend/Compute.ts"
import {
  planCloudflareRun,
  type CloudflareBackendPlan,
  type PlanCloudflareRunInput,
} from "./CloudflareRunPlan.ts"

const baseInput = (
  overrides: {
    readonly config?: Partial<AfkConfig>
    readonly startInput?: Partial<StartInput>
    readonly composeContent?: string
  } = {},
): PlanCloudflareRunInput => ({
  config: {
    gitUrl: "https://github.com/acme/widget.git",
    ...overrides.config,
  } as AfkConfig,
  envEntries: [],
  sourceRepoName: "widget",
  workerUrl: "https://afk.example.workers.dev",
  principalId: "client-abc",
  composeContent: overrides.composeContent,
  input: {
    command: ["claude", "go"],
    built: {
      image: "registry.cloudflare.com/acct/widget:abc123",
      tag: "abc123",
      sha: "abc123",
      branch: "main",
      skipped: false,
    },
    ...overrides.startInput,
  },
  runId: "11111111-2222-3333-4444-555555555555",
  startedAt: "2026-05-24T00:00:00.000Z",
})

describe("planCloudflareRun", () => {
  it("resolves a Run Plan from a valid request", () => {
    const result = planCloudflareRun(baseInput())
    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result)) {
      const { prepared } = result.right
      expect(prepared.runId).toBe("11111111-2222-3333-4444-555555555555")
      expect(prepared.owner).toBe("client-abc")
      expect(prepared.image).toBe(
        "registry.cloudflare.com/acct/widget:abc123",
      )
      expect(prepared.logChannel).toBe(
        "Workers Logs (runId=11111111-2222-3333-4444-555555555555)",
      )
      const cf = prepared.backendPlan as CloudflareBackendPlan
      expect(cf.workerUrl).toBe("https://afk.example.workers.dev")
      expect(cf.instanceTier).toBe("standard-1") // default tier
      expect(cf.startedAt).toBe("2026-05-24T00:00:00.000Z")
    }
  })

  it("honours the instance-tier override", () => {
    const result = planCloudflareRun(
      baseInput({
        startInput: { backendOverrides: { instanceType: "standard-4" } },
      }),
    )
    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result)) {
      const cf = result.right.prepared.backendPlan as CloudflareBackendPlan
      expect(cf.instanceTier).toBe("standard-4")
    }
  })

  it("rejects an invalid compose graph with a UserError", () => {
    const result = planCloudflareRun(
      baseInput({ composeContent: "this: is: not: valid: yaml: : :" }),
    )
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("UserError")
    }
  })

  it("is deterministic — same input, identical plan (no clock/randomness)", () => {
    const a = planCloudflareRun(baseInput())
    const b = planCloudflareRun(baseInput())
    expect(Either.isRight(a) && Either.isRight(b)).toBe(true)
    if (Either.isRight(a) && Either.isRight(b)) {
      expect(a.right.prepared).toEqual(b.right.prepared)
    }
  })
})
