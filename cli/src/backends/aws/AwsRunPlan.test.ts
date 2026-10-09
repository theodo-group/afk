import { describe, it, expect } from "bun:test"
import { Either } from "effect"
import type { AfkConfig } from "../../schema/Config.ts"
import type { StartInput } from "../../services/backend/Compute.ts"
import {
  ec2InstanceToRun,
  planAwsRun,
  type PlanAwsRunInput,
} from "./AwsRunPlan.ts"
import {
  TAG_BRANCH,
  TAG_MANAGED,
  TAG_OWNER,
  TAG_RETAIN,
  TAG_RUN_ID,
  TAG_SUBMITTED_BY,
} from "../../constants.ts"

const baseInput = (
  overrides: {
    readonly config?: Partial<AfkConfig>
    readonly startInput?: Partial<StartInput>
    readonly identity?: Partial<PlanAwsRunInput["identity"]>
  } = {},
): PlanAwsRunInput => ({
  config: {
    gitUrl: "https://github.com/acme/widget.git",
    ...overrides.config,
  } as AfkConfig,
  envEntries: [],
  sourceRepoName: "widget",
  identity: {
    Account: "111122223333",
    UserId: "AIDAEXAMPLE",
    ...overrides.identity,
  },
  latestGoldenId: "ami-0abc",
  composeContent: undefined,
  input: {
    command: ["claude", "go"],
    envEntries: [],
    composeContent: undefined,
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

  it("tags a Run with the whole userid, so afk:owner names a developer", () => {
    const result = planAwsRun(
      baseInput({ identity: { UserId: "AROAEXAMPLE:alice.martin" } }),
    )
    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result)) {
      const core = result.right
      expect(core.preparedBase.owner).toBe("AROAEXAMPLE:alice.martin")
      const tags = Object.fromEntries(
        core.backendPlanBase.tags.map((t) => [t.key, t.value]),
      )
      expect(tags[TAG_OWNER]).toBe("AROAEXAMPLE:alice.martin")
      expect(core.warnings).toEqual([])
    }
  })

  it("makes a hand-launched Run's Submitter its Owner", () => {
    const result = planAwsRun(
      baseInput({ identity: { UserId: "AROAEXAMPLE:alice.martin" } }),
    )
    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result)) {
      const core = result.right
      expect(core.preparedBase.submittedBy).toBe("AROAEXAMPLE:alice.martin")
      const tags = Object.fromEntries(
        core.backendPlanBase.tags.map((t) => [t.key, t.value]),
      )
      expect(tags[TAG_SUBMITTED_BY]).toBe("AROAEXAMPLE:alice.martin")
    }
  })

  it("keeps a Scheduler-launched Run's Owner, and records who submitted it", () => {
    // The launch permission only lets a caller tag its own identity as Owner,
    // so the Scheduler stays the Owner; the submitter rides beside it.
    const result = planAwsRun(
      baseInput({
        identity: { UserId: "AROASCHED:dev-afk-scheduler" },
        startInput: { submittedBy: "AROAEXAMPLE:alice.martin" },
      }),
    )
    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result)) {
      const core = result.right
      expect(core.preparedBase.owner).toBe("AROASCHED:dev-afk-scheduler")
      expect(core.preparedBase.submittedBy).toBe("AROAEXAMPLE:alice.martin")
      const tags = Object.fromEntries(
        core.backendPlanBase.tags.map((t) => [t.key, t.value]),
      )
      expect(tags[TAG_OWNER]).toBe("AROASCHED:dev-afk-scheduler")
      expect(tags[TAG_SUBMITTED_BY]).toBe("AROAEXAMPLE:alice.martin")
    }
  })

  it("falls back to the role, and warns, when the session names nobody", () => {
    const result = planAwsRun(
      baseInput({
        identity: { UserId: "AROAEXAMPLE:botocore-session-1789562608" },
      }),
    )
    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result)) {
      const core = result.right
      expect(core.preparedBase.owner).toBe("AROAEXAMPLE")
      expect(core.warnings.join(" ")).toContain("botocore-session-1789562608")
    }
  })

  it("launches an IAM user's Run unwarned — there is no session to name", () => {
    const result = planAwsRun(baseInput())
    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result)) expect(result.right.warnings).toEqual([])
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

  it("does not retain by default: terminate-on-shutdown, no retain tag", () => {
    const result = planAwsRun(baseInput())
    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result)) {
      expect(result.right.backendPlanBase.retain).toBe(false)
      expect(result.right.backendPlanBase.shutdownBehavior).toBe("terminate")
      const tags = Object.fromEntries(
        result.right.backendPlanBase.tags.map((t) => [t.key, t.value]),
      )
      expect(tags[TAG_RETAIN]).toBeUndefined()
    }
  })

  it("--retain implies On-Demand, stop-on-shutdown, and the retain tag", () => {
    const result = planAwsRun(baseInput({ startInput: { retain: true } }))
    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result)) {
      // retain auto-upgrades a would-be Spot Run to On-Demand.
      expect(result.right.backendPlanBase.spot).toBe(false)
      expect(result.right.backendPlanBase.retain).toBe(true)
      expect(result.right.backendPlanBase.shutdownBehavior).toBe("stop")
      const tags = Object.fromEntries(
        result.right.backendPlanBase.tags.map((t) => [t.key, t.value]),
      )
      expect(tags[TAG_RETAIN]).toBe("true")
    }
  })

  it("rejects --retain combined with explicit --spot", () => {
    const result = planAwsRun(
      baseInput({
        startInput: { retain: true, backendOverrides: { spot: true } },
      }),
    )
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("UserError")
      expect(result.left.message).toContain("--retain cannot be combined")
    }
  })

  // The VM records its own completion, so the table it writes to must be the
  // one AwsRunHistory reads from — both derive it from the same prefix.
  it("points the VM's completion write at the default history table", () => {
    const result = planAwsRun(baseInput())
    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result)) {
      expect(result.right.backendPlanBase.userData).toContain(
        "--table-name 'afk-runs'",
      )
    }
  })

  it("follows aws.resourcePrefix to the project's own history table", () => {
    const result = planAwsRun(
      baseInput({ config: { aws: { resourcePrefix: "acme" } } }),
    )
    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result)) {
      expect(result.right.backendPlanBase.userData).toContain(
        "--table-name 'acme-runs'",
      )
    }
  })
})

describe("ec2InstanceToRun retention", () => {
  const baseInstance = {
    instanceId: "i-0abc",
    instanceType: "t3.medium",
    imageId: "ami-0abc",
    tags: [
      { key: TAG_RUN_ID, value: "run-1" },
      { key: TAG_OWNER, value: "AIDAEXAMPLE" },
      { key: TAG_BRANCH, value: "main" },
      { key: TAG_MANAGED, value: "true" },
    ],
  }

  it("reads the Submitter back off its tag", () => {
    const run = ec2InstanceToRun(
      {
        ...baseInstance,
        state: "running",
        tags: [
          ...baseInstance.tags,
          { key: TAG_SUBMITTED_BY, value: "AROAEXAMPLE:alice.martin" },
        ],
      },
      7,
    )
    expect(run?.owner).toBe("AIDAEXAMPLE")
    expect(run?.submittedBy).toBe("AROAEXAMPLE:alice.martin")
  })

  it("leaves the Submitter absent on an instance launched before the tag", () => {
    // Readers fall back to the Owner; inventing one here would hide that.
    const run = ec2InstanceToRun({ ...baseInstance, state: "running" }, 7)
    expect(run?.submittedBy).toBeUndefined()
  })

  it("sets retainedUntil for a stopped, retained instance", () => {
    const run = ec2InstanceToRun(
      {
        ...baseInstance,
        state: "stopped",
        tags: [...baseInstance.tags, { key: TAG_RETAIN, value: "true" }],
        stateTransitionReason: "User initiated (2026-06-01 00:00:00 GMT)",
      },
      7,
    )
    expect(run?.status).toBe("STOPPED")
    expect(run?.retainedUntil).toBe("2026-06-08T00:00:00.000Z")
  })

  it("omits retainedUntil for a terminated (reclaimed) instance", () => {
    const run = ec2InstanceToRun(
      {
        ...baseInstance,
        state: "terminated",
        tags: [...baseInstance.tags, { key: TAG_RETAIN, value: "true" }],
        stateTransitionReason: "User initiated (2026-06-01 00:00:00 GMT)",
      },
      7,
    )
    expect(run?.retainedUntil).toBeUndefined()
  })

  it("omits retainedUntil for a stopped instance that was not retained", () => {
    const run = ec2InstanceToRun(
      {
        ...baseInstance,
        state: "stopped",
        stateTransitionReason: "User initiated (2026-06-01 00:00:00 GMT)",
      },
      7,
    )
    expect(run?.retainedUntil).toBeUndefined()
  })
})
