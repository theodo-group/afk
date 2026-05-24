import { describe, it, expect } from "bun:test"
import { Either } from "effect"
import type { AfkConfig } from "../../schema/Config.ts"
import type { StartInput } from "../../services/backend/Compute.ts"
import { planLocalRun, type PlanLocalRunInput } from "./LocalRunPlan.ts"
import { LOCAL_OWNER_ID } from "../../constants.ts"

const baseInput = (
  overrides: {
    readonly config?: Partial<AfkConfig>
    readonly startInput?: Partial<StartInput>
    readonly composeContent?: string
  } = {},
): PlanLocalRunInput => ({
  config: {
    gitUrl: "https://github.com/acme/widget.git",
    ...overrides.config,
  } as AfkConfig,
  envEntries: [],
  sourceRepoName: "widget",
  goldenImageId: "afk-golden-local:abc123",
  composeContent: overrides.composeContent,
  input: {
    command: ["claude", "go"],
    built: {
      image: "acme/widget:abc123",
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

describe("planLocalRun", () => {
  it("resolves a Run Plan from a valid request", () => {
    const result = planLocalRun(baseInput())
    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result)) {
      const { plan } = result.right
      expect(plan.runId).toBe("11111111-2222-3333-4444-555555555555")
      expect(plan.owner).toBe(LOCAL_OWNER_ID)
      expect(plan.image).toBe("acme/widget:abc123")
      expect(plan.composeUsed).toBe(false)
      const backendPlan = plan.backendPlan as {
        readonly goldenImage: string
        readonly startedAt: string
      }
      expect(backendPlan.goldenImage).toBe("afk-golden-local:abc123")
      expect(backendPlan.startedAt).toBe("2026-05-24T00:00:00.000Z")
    }
  })

  it("rejects an invalid compose graph with a UserError", () => {
    const result = planLocalRun(baseInput({ composeContent: "version: '3'\n" }))
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("UserError")
    }
  })

  it("is deterministic — same input, identical plan (no clock/randomness)", () => {
    const a = planLocalRun(baseInput())
    const b = planLocalRun(baseInput())
    expect(Either.isRight(a) && Either.isRight(b)).toBe(true)
    if (Either.isRight(a) && Either.isRight(b)) {
      expect(a.right.plan).toEqual(b.right.plan)
    }
  })
})
