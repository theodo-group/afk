import { describe, it, expect } from "bun:test"
import { Either } from "effect"
import type { AfkConfig } from "../../schema/Config.ts"
import type { StartInput } from "../../services/backend/Compute.ts"
import {
  gceInstanceToRun,
  planGcpRun,
  sanitizeLabel,
  type PlanGcpRunInput,
} from "./GcpRunPlan.ts"
import {
  GCP_LABEL_MANAGED,
  GCP_LABEL_OWNER,
  GCP_LABEL_RETAIN,
  GCP_LABEL_RUN_ID,
} from "../../constants.ts"

const baseInput = (
  overrides: {
    readonly config?: Partial<AfkConfig>
    readonly startInput?: Partial<StartInput>
  } = {},
): PlanGcpRunInput => ({
  config: {
    gitUrl: "https://github.com/acme/widget.git",
    ...overrides.config,
  } as AfkConfig,
  envEntries: [],
  sourceRepoName: "widget",
  project: "acme-prod",
  ownerAccount: "dev@acme.com",
  goldenImageFamily: "afk-golden",
  composeContent: undefined,
  input: {
    command: ["claude", "go"],
    built: {
      image: "us-central1-docker.pkg.dev/acme-prod/afk/widget:abc123",
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

describe("planGcpRun", () => {
  it("resolves a Run Plan core from a valid request", () => {
    const result = planGcpRun(baseInput())
    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result)) {
      const core = result.right
      expect(core.preparedBase.runId).toBe(
        "11111111-2222-3333-4444-555555555555",
      )
      expect(core.preparedBase.owner).toBe("dev@acme.com") // raw email preserved
      expect(core.backendPlanBase.imageFamily).toBe("afk-golden")
      const labels = Object.fromEntries(
        core.backendPlanBase.labels.map((l) => [l.key, l.value]),
      )
      // Owner label is sanitized to the GCE charset; the @ and . become -.
      expect(labels[GCP_LABEL_OWNER]).toBe("dev-acme-com")
      expect(labels[GCP_LABEL_RUN_ID]).toBe(
        "11111111-2222-3333-4444-555555555555",
      )
      expect(labels[GCP_LABEL_MANAGED]).toBe("true")
    }
  })

  it("rejects a machine type outside allowedMachineTypes", () => {
    const result = planGcpRun(
      baseInput({
        config: { gcp: { allowedMachineTypes: ["e2-standard-4"] } },
        startInput: { backendOverrides: { instanceType: "a2-highgpu-1g" } },
      }),
    )
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("UserError")
      expect(result.left.message).toContain("allowedMachineTypes")
    }
  })

  it("honours the instance-type override (machine type) when whitelisted", () => {
    const result = planGcpRun(
      baseInput({
        config: {
          gcp: { allowedMachineTypes: ["e2-standard-4", "n2-standard-8"] },
        },
        startInput: { backendOverrides: { instanceType: "n2-standard-8" } },
      }),
    )
    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result)) {
      expect(result.right.backendPlanBase.machineType).toBe("n2-standard-8")
    }
  })

  it("defaults to Spot capacity", () => {
    const result = planGcpRun(baseInput())
    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result)) {
      expect(result.right.backendPlanBase.spot).toBe(true)
    }
  })

  it("honours the --on-demand override (Spot disabled)", () => {
    const result = planGcpRun(
      baseInput({ startInput: { backendOverrides: { onDemand: true } } }),
    )
    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result)) {
      expect(result.right.backendPlanBase.spot).toBe(false)
    }
  })

  it("--retain implies On-Demand, retain flag, and the retain label", () => {
    const result = planGcpRun(baseInput({ startInput: { retain: true } }))
    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result)) {
      expect(result.right.backendPlanBase.spot).toBe(false)
      expect(result.right.backendPlanBase.retain).toBe(true)
      const labels = Object.fromEntries(
        result.right.backendPlanBase.labels.map((l) => [l.key, l.value]),
      )
      expect(labels[GCP_LABEL_RETAIN]).toBe("true")
    }
  })

  it("rejects --retain combined with explicit --spot", () => {
    const result = planGcpRun(
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

  it("is deterministic — same input, identical labels (no clock/randomness)", () => {
    const a = planGcpRun(baseInput())
    const b = planGcpRun(baseInput())
    expect(Either.isRight(a) && Either.isRight(b)).toBe(true)
    if (Either.isRight(a) && Either.isRight(b)) {
      expect(a.right.backendPlanBase.labels).toEqual(
        b.right.backendPlanBase.labels,
      )
    }
  })
})

describe("gceInstanceToRun", () => {
  it("maps labels back into a Run, collapsing GCE status", () => {
    const run = gceInstanceToRun(
      {
        name: "afk-widget-11111111",
        id: "42",
        status: "RUNNING",
        machineType: "e2-standard-4",
        zone: "us-central1-a",
        creationTimestamp: "2026-05-24T00:00:00.000Z",
        labels: [
          { key: GCP_LABEL_RUN_ID, value: "run-1" },
          { key: GCP_LABEL_OWNER, value: "dev-acme-com" },
          { key: "afk-branch", value: "main" },
        ],
      },
      7,
    )
    expect(run).not.toBeNull()
    expect(run?.status).toBe("RUNNING")
    expect(run?.backend).toBe("gcp")
    expect(run?.resourceId).toBe("afk-widget-11111111")
    expect(run?.branch).toBe("main")
  })

  it("returns null when the run-id/owner labels are absent", () => {
    const run = gceInstanceToRun(
      {
        name: "some-other-vm",
        id: "7",
        status: "RUNNING",
        machineType: "e2-standard-4",
        zone: "us-central1-a",
        labels: [],
      },
      7,
    )
    expect(run).toBeNull()
  })

  it("sets retainedUntil for a stopped (TERMINATED), retained instance", () => {
    const run = gceInstanceToRun(
      {
        name: "afk-widget-11111111",
        id: "42",
        status: "TERMINATED",
        machineType: "e2-standard-4",
        zone: "us-central1-a",
        lastStopTimestamp: "2026-06-01T00:00:00.000Z",
        labels: [
          { key: GCP_LABEL_RUN_ID, value: "run-1" },
          { key: GCP_LABEL_OWNER, value: "dev-acme-com" },
          { key: GCP_LABEL_RETAIN, value: "true" },
        ],
      },
      7,
    )
    expect(run?.status).toBe("STOPPED")
    expect(run?.retainedUntil).toBe("2026-06-08T00:00:00.000Z")
  })

  it("omits retainedUntil for a stopped instance that was not retained", () => {
    const run = gceInstanceToRun(
      {
        name: "afk-widget-11111111",
        id: "42",
        status: "TERMINATED",
        machineType: "e2-standard-4",
        zone: "us-central1-a",
        lastStopTimestamp: "2026-06-01T00:00:00.000Z",
        labels: [
          { key: GCP_LABEL_RUN_ID, value: "run-1" },
          { key: GCP_LABEL_OWNER, value: "dev-acme-com" },
        ],
      },
      7,
    )
    expect(run?.retainedUntil).toBeUndefined()
  })

  it("sanitizeLabel lowercases and replaces disallowed chars", () => {
    expect(sanitizeLabel("Dev@Acme.com")).toBe("dev-acme-com")
    expect(sanitizeLabel("feature/Foo")).toBe("feature-foo")
  })
})
