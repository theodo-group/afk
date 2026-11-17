import { describe, expect, it } from "bun:test"
import { Either } from "effect"
import type { AfkConfig, EnvEntry } from "../../schema/Config.ts"
import type { StartInput } from "../../services/backend/Compute.ts"
import type { AzureVm } from "../../adapters/azure/AzVm.ts"
import { azureResourceNames } from "../../adapters/azure/AzureNames.ts"
import {
  type AzureBackendPlan,
  type PlanAzureRunInput,
  azureSecretNameProblem,
  azureVmToRun,
  planAzureRun,
} from "./AzureRunPlan.ts"
import {
  AZURE_TAG_MANAGED,
  AZURE_TAG_OWNER,
  AZURE_TAG_RETAIN,
  AZURE_TAG_RUN_ID,
  AZURE_TAG_STOPPED_AT,
  AZURE_TAG_SUBMITTED_BY,
} from "../../constants.ts"

const coords = {
  subscriptionId: "00000000-1111-2222-3333-444444444444",
  resourceGroup: "afk",
  location: "westeurope",
}
const RUN_ID = "11111111-2222-3333-4444-555555555555"

const baseInput = (
  overrides: {
    readonly config?: Partial<AfkConfig>
    readonly startInput?: Partial<StartInput>
    readonly envEntries?: ReadonlyArray<EnvEntry>
  } = {},
): PlanAzureRunInput => ({
  config: {
    gitUrl: "https://github.com/acme/widget.git",
    ...overrides.config,
  } as AfkConfig,
  envEntries: overrides.envEntries ?? [],
  sourceRepoName: "widget",
  coords,
  names: azureResourceNames(coords),
  owner: "dev@acme.com",
  goldenImageId:
    "/subscriptions/x/resourceGroups/afk/providers/Microsoft.Compute/images/afk-golden-1",
  composeContent: undefined,
  input: {
    command: ["claude", "go"],
    envEntries: [],
    composeContent: undefined,
    built: {
      image: "afkabc.azurecr.io/afk/widget:abc123",
      tag: "abc123",
      sha: "abc123",
      branch: "feat/x",
      skipped: false,
    },
    ...overrides.startInput,
  },
  runId: RUN_ID,
  startedAt: "2026-11-12T00:00:00.000Z",
  adminSshPublicKey: "ssh-rsa AAAA afk-unused",
})

const planOf = (input: PlanAzureRunInput) => {
  const result = planAzureRun(input)
  if (Either.isLeft(result)) throw result.left
  return {
    ...result.right,
    azure: result.right.prepared.backendPlan as AzureBackendPlan,
  }
}

describe("planAzureRun", () => {
  it("resolves a Spot Run tagged with its Owner, verbatim", () => {
    const { prepared, azure } = planOf(baseInput())
    expect(prepared.owner).toBe("dev@acme.com")
    expect(prepared.submittedBy).toBe("dev@acme.com")
    expect(azure.spot).toBe(true)
    expect(azure.retain).toBe(false)
    expect(azure.vmSize).toBe("Standard_D4s_v5")
    expect(azure.vmName).toBe("afk-widget-11111111")
    // Azure tag values take an email and a ref as they are.
    expect(azure.tags[AZURE_TAG_OWNER]).toBe("dev@acme.com")
    expect(azure.tags[AZURE_TAG_RUN_ID]).toBe(RUN_ID)
    expect(azure.tags[AZURE_TAG_MANAGED]).toBe("true")
    expect(azure.tags[AZURE_TAG_RETAIN]).toBeUndefined()
    expect(azure.subnetId).toEndWith(
      "/virtualNetworks/afk-vnet/subnets/afk-subnet",
    )
  })

  it("records the Scheduler's submitter beside the Owner", () => {
    const { azure, prepared } = planOf(
      baseInput({ startInput: { submittedBy: "alice@acme.com" } }),
    )
    expect(prepared.submittedBy).toBe("alice@acme.com")
    expect(azure.tags[AZURE_TAG_SUBMITTED_BY]).toBe("alice@acme.com")
  })

  it("makes --retain imply On-Demand", () => {
    const { azure } = planOf(baseInput({ startInput: { retain: true } }))
    expect(azure.spot).toBe(false)
    expect(azure.retain).toBe(true)
    expect(azure.tags[AZURE_TAG_RETAIN]).toBe("true")
    expect(azure.customData).toContain("az vm deallocate")
    expect(azure.customData).not.toContain("az vm delete")
  })

  it("refuses --spot --retain", () => {
    const result = planAzureRun(
      baseInput({
        startInput: { retain: true, backendOverrides: { spot: true } },
      }),
    )
    expect(Either.isLeft(result)).toBe(true)
  })

  it("refuses a VM size outside allowedVmSizes", () => {
    const result = planAzureRun(
      baseInput({
        config: { azure: { allowedVmSizes: ["Standard_D2s_v5"] } },
        startInput: { backendOverrides: { instanceType: "Standard_D64s_v5" } },
      }),
    )
    expect(Either.isLeft(result)).toBe(true)
  })

  it("refuses a secret Key Vault cannot name", () => {
    const result = planAzureRun(
      baseInput({
        envEntries: [
          { kind: "secret", name: "GITHUB_TOKEN", secretName: "github_token" },
        ],
      }),
    )
    expect(Either.isLeft(result)).toBe(true)
  })

  it("reads secrets from the project's Key Vault at boot", () => {
    const { azure } = planOf(
      baseInput({
        envEntries: [
          { kind: "secret", name: "GITHUB_TOKEN", secretName: "github-token" },
        ],
      }),
    )
    const names = azureResourceNames(coords)
    expect(azure.customData).toContain(
      `az keyvault secret show --vault-name '${names.keyVault}' --name 'afk-secret-github-token'`,
    )
    // The secret value never reaches the plan; only its reference does.
    expect(azure.customData).toContain(
      "printf '%s=%s\\n' 'GITHUB_TOKEN' \"$_val\"",
    )
  })
})

describe("azureSecretNameProblem", () => {
  it("accepts letters, digits and dashes only", () => {
    expect(azureSecretNameProblem("github-token")).toBeUndefined()
    expect(azureSecretNameProblem("github_token")).toBeDefined()
    expect(azureSecretNameProblem("a/b")).toBeDefined()
  })
})

const vm = (over: Partial<AzureVm> = {}): AzureVm => ({
  id: "/subscriptions/x/…/afk-widget-11111111",
  name: "afk-widget-11111111",
  powerState: "VM running",
  provisioningState: "Succeeded",
  size: "Standard_D4s_v5",
  location: "westeurope",
  tags: {
    [AZURE_TAG_RUN_ID]: RUN_ID,
    [AZURE_TAG_OWNER]: "dev@acme.com",
    [AZURE_TAG_MANAGED]: "true",
  },
  ...over,
})

describe("azureVmToRun", () => {
  it("ignores a VM afk did not launch", () => {
    expect(azureVmToRun(vm({ tags: {} }), 7)).toBeNull()
  })

  it("maps power states onto the neutral Run status", () => {
    expect(azureVmToRun(vm(), 7)?.status).toBe("RUNNING")
    expect(azureVmToRun(vm({ powerState: undefined }), 7)?.status).toBe(
      "PROVISIONING",
    )
    expect(azureVmToRun(vm({ powerState: "VM deallocating" }), 7)?.status).toBe(
      "STOPPING",
    )
    expect(azureVmToRun(vm({ provisioningState: "Deleting" }), 7)?.status).toBe(
      "STOPPING",
    )
    expect(azureVmToRun(vm({ powerState: "VM deallocated" }), 7)?.status).toBe(
      "STOPPED",
    )
  })

  it("dates a retained Run's window from the stop time it stamped", () => {
    const run = azureVmToRun(
      vm({
        powerState: "VM deallocated",
        tags: {
          ...vm().tags,
          [AZURE_TAG_RETAIN]: "true",
          [AZURE_TAG_STOPPED_AT]: "2026-11-01T00:00:00Z",
        },
      }),
      7,
    )
    expect(run?.retainedUntil).toBe("2026-11-08T00:00:00.000Z")
  })

  it("does not mark a deallocated, non-retained VM resumable", () => {
    const run = azureVmToRun(vm({ powerState: "VM deallocated" }), 7)
    expect(run?.retainedUntil).toBeUndefined()
  })
})
