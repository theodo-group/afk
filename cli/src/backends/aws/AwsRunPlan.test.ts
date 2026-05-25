import { describe, it, expect } from "bun:test"
import { Either } from "effect"
import type { AfkConfig } from "../../schema/Config.ts"
import type { StartInput } from "../../services/backend/Compute.ts"
import { planAwsRun, type PlanAwsRunInput } from "./AwsRunPlan.ts"
import { TAG_OWNER, TAG_RUN_ID } from "../../constants.ts"

const baseInput = (
  overrides: {
    readonly config?: Partial<AfkConfig>
    readonly startInput?: Partial<StartInput>
  } = {},
): PlanAwsRunInput => ({
  config: {
    gitUrl: "https://github.com/acme/widget.git",
    ...overrides.config,
  } as AfkConfig,
  envEntries: [],
  sourceRepoName: "widget",
  identity: { Account: "111122223333", UserId: "AIDAEXAMPLE" },
  latestGoldenId: "ami-0abc",
  composeContent: undefined,
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

describe("planAwsRun", () => {
  it("resolves a Run Plan core from a valid request", () => {
    const result = planAwsRun(baseInput())
    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result)) {
      const core = result.right
      expect(core.preparedBase.runId).toBe(
        "11111111-2222-3333-4444-555555555555",
      )
      expect(core.preparedBase.owner).toBe("AIDAEXAMPLE")
      expect(core.preparedBase.image).toBe("acme/widget:abc123")
      expect(core.backendPlanBase.amiId).toBe("ami-0abc")
      expect(core.backendPlanBase.spot).toBe(true) // Spot by default
      const tags = Object.fromEntries(
        core.backendPlanBase.tags.map((t) => [t.key, t.value]),
      )
      expect(tags[TAG_OWNER]).toBe("AIDAEXAMPLE")
      expect(tags[TAG_RUN_ID]).toBe("11111111-2222-3333-4444-555555555555")
    }
  })

  it("rejects an instance type outside allowedInstanceTypes", () => {
    const result = planAwsRun(
      baseInput({
        config: { allowedInstanceTypes: ["t3.large"] },
        startInput: { backendOverrides: { instanceType: "p4d.24xlarge" } },
      }),
    )
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("UserError")
      expect(result.left.message).toContain("allowedInstanceTypes")
    }
  })

  it("honours the --on-demand override (spot disabled)", () => {
    const result = planAwsRun(
      baseInput({ startInput: { backendOverrides: { onDemand: true } } }),
    )
    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result)) {
      expect(result.right.backendPlanBase.spot).toBe(false)
    }
  })

  it("is deterministic — same input, identical tags (no clock/randomness)", () => {
    const a = planAwsRun(baseInput())
    const b = planAwsRun(baseInput())
    expect(Either.isRight(a) && Either.isRight(b)).toBe(true)
    if (Either.isRight(a) && Either.isRight(b)) {
      expect(a.right.backendPlanBase.tags).toEqual(b.right.backendPlanBase.tags)
    }
  })
})
