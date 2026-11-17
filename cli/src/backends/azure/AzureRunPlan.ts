import { Either } from "effect"
import type { AfkConfig, EnvEntry } from "../../schema/Config.ts"
import type { Run, RunStatus } from "../../schema/Run.ts"
import type {
  PreparedRun,
  RunStarted,
  StartInput,
} from "../../services/backend/Compute.ts"
import type { AzureVm } from "../../adapters/azure/AzVm.ts"
import { UserError } from "../../infra/Errors.ts"
import { assembleRunPlan } from "../../services/RunPlan.ts"
import { collectionBases } from "../../services/SessionArtifact.ts"
import { retainedUntilIso } from "../../services/retention.ts"
import { buildAzureCustomData } from "./AzureCustomData.ts"
import type {
  AzureCoords,
  AzureResourceNames,
} from "../../adapters/azure/AzureNames.ts"
import {
  AZURE_DEFAULT_VM_SIZE,
  AZURE_TAG_BRANCH,
  AZURE_TAG_MANAGED,
  AZURE_TAG_OWNER,
  AZURE_TAG_REPO,
  AZURE_TAG_RETAIN,
  AZURE_TAG_RUN_ID,
  AZURE_TAG_SHA,
  AZURE_TAG_STARTED_AT,
  AZURE_TAG_STOPPED_AT,
  AZURE_TAG_SUBMITTED_BY,
  AZURE_TAG_TIMEOUT_HOURS,
  AZURE_TAG_VALUE_MAX,
  DEFAULT_MAIN_SERVICE,
  SESSION_ARTIFACT_MAX_BYTES,
} from "../../constants.ts"

// ---------------------------------------------------------------------------
// Functional core for the Azure Backend: pure, no I/O, no clock, no randomness.
// The shell (`AzureCompute`) gathers the effectful inputs (config, az identity,
// Golden Image, resource names) and injects the non-deterministic seeds
// (`runId`, `startedAt`, the throwaway admin key), then translates the returned
// data — `Either` for refusals, `warnings` for findings — into the Effect
// channel. Mirrors `GcpRunPlan.ts`.
// ---------------------------------------------------------------------------

/** Key Vault secret names allow only [0-9a-zA-Z-]. */
const KEY_VAULT_NAME = /^[0-9a-zA-Z-]+$/

/** Why `name` cannot be an Azure secret name, or undefined when it can. */
export const azureSecretNameProblem = (name: string): string | undefined =>
  KEY_VAULT_NAME.test(name)
    ? undefined
    : `secret name '${name}' is not valid on Azure — Key Vault allows only letters, digits and '-'.`

const mapPowerState = (vm: AzureVm): RunStatus => {
  if (vm.provisioningState === "Deleting") return "STOPPING"
  switch (vm.powerState) {
    case "VM running":
      return "RUNNING"
    case "VM stopping":
    case "VM deallocating":
      return "STOPPING"
    case "VM stopped":
    case "VM deallocated":
      return "STOPPED"
    default:
      // No power state yet, or "VM starting": the VM is still being created.
      return "PROVISIONING"
  }
}

/** The neutral Run an afk-managed VM maps to, or null for a foreign VM. Pure. */
export const azureVmToRun = (
  vm: AzureVm,
  retentionDays: number,
): Run | null => {
  const t = vm.tags
  const runId = t[AZURE_TAG_RUN_ID]
  const owner = t[AZURE_TAG_OWNER]
  if (!runId || !owner) return null

  // A deallocated VM tagged afk-retain is a retained Run, resumable until its
  // window closes. A reclaimed Run's VM is gone, so it never reaches here.
  const isRetained =
    vm.powerState === "VM deallocated" && t[AZURE_TAG_RETAIN] === "true"
  const stoppedAt = isRetained ? t[AZURE_TAG_STOPPED_AT] : undefined
  const retainedUntil =
    isRetained && stoppedAt
      ? retainedUntilIso(stoppedAt, retentionDays)
      : undefined

  return {
    runId: runId as Run["runId"],
    resourceId: vm.name,
    status: mapPowerState(vm),
    backend: "azure",
    owner,
    ...(t[AZURE_TAG_SUBMITTED_BY]
      ? { submittedBy: t[AZURE_TAG_SUBMITTED_BY] }
      : {}),
    branch: t[AZURE_TAG_BRANCH] ?? "",
    sha: t[AZURE_TAG_SHA] ?? "",
    image: vm.size,
    backendDetails: { vmSize: vm.size, location: vm.location },
    startedAt: t[AZURE_TAG_STARTED_AT] ?? vm.timeCreated,
    stoppedAt,
    stopReason: undefined,
    ...(retainedUntil ? { retainedUntil } : {}),
  }
}

/** Azure VM names: [a-zA-Z0-9-], ≤64 chars, no leading/trailing hyphen. */
const vmName = (repo: string, runId: string): string =>
  `afk-${repo}`
    .replace(/[^a-zA-Z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 64 - 9)
    .replace(/-$/, "")
    .concat(`-${runId.slice(0, 8)}`)

const tagValue = (v: string): string => v.slice(0, AZURE_TAG_VALUE_MAX)

/**
 * Provider-specific launch description, carried opaquely in
 * `PreparedRun.backendPlan`. A closed `type` so it is assignable to that
 * record without a double cast (code-style.md §4).
 */
export type AzureBackendPlan = {
  readonly resourceGroup: string
  readonly location: string
  readonly vmName: string
  readonly vmSize: string
  /** Resource id of the Golden managed image the Run boots from. */
  readonly imageId: string
  readonly osDiskSizeGb: number | undefined
  /** Spot (evicted by deletion) vs Regular On-Demand. */
  readonly spot: boolean
  /** Deallocate, not delete, on exit — post-mortem attach. On-Demand only. */
  readonly retain: boolean
  readonly subnetId: string
  readonly identityId: string
  readonly adminSshPublicKey: string
  readonly tags: Readonly<Record<string, string>>
  readonly customData: string
  readonly imageWasSkipped: boolean
  readonly startedAt: string
}

export interface PlanAzureRunInput {
  readonly config: AfkConfig
  readonly envEntries: ReadonlyArray<EnvEntry>
  readonly sourceRepoName: string
  readonly coords: AzureCoords
  readonly names: AzureResourceNames
  readonly owner: string
  readonly goldenImageId: string
  /** Raw `afk.compose.yml`, pre-read by the shell; absent when none. */
  readonly composeContent: string | undefined
  readonly input: StartInput
  /** Injected by the shell — keeps the core deterministic. */
  readonly runId: string
  readonly startedAt: string
  readonly adminSshPublicKey: string
}

export interface AzureRunCore {
  readonly warnings: ReadonlyArray<string>
  readonly prepared: PreparedRun
}

const flag = (v: string | boolean | number | undefined): boolean =>
  v === true || v === "true"

/** Resolve a StartInput into the Azure Run Plan, or a UserError saying why it
 *  cannot launch. Pure. */
export const planAzureRun = (
  i: PlanAzureRunInput,
): Either.Either<AzureRunCore, UserError> => {
  const { config, input, coords, names } = i

  // The neutral `--instance-type` is the cross-Backend size selector; on Azure
  // its value space is VM sizes.
  const sizeOverride =
    typeof input.backendOverrides?.instanceType === "string"
      ? input.backendOverrides.instanceType
      : undefined
  const vmSize =
    sizeOverride ?? config.azure?.defaultVmSize ?? AZURE_DEFAULT_VM_SIZE

  // Spot by default; `--on-demand` opts up to Regular. Only Regular capacity
  // can deallocate without being evicted, so `--retain` implies On-Demand and
  // `--spot --retain` is refused (CONTEXT.md "Retention").
  const retain = input.retain === true
  if (retain && flag(input.backendOverrides?.spot)) {
    return Either.left(
      new UserError({
        message: "--retain cannot be combined with --spot.",
        hint: "Spot capacity is evicted by deletion, so a Spot Run can never be retained. Drop --spot (--retain implies On-Demand).",
      }),
    )
  }
  const spot = !(flag(input.backendOverrides?.onDemand) || retain)

  const allowed = config.azure?.allowedVmSizes
  if (allowed && allowed.length > 0 && !allowed.includes(vmSize)) {
    return Either.left(
      new UserError({
        message: `VM size '${vmSize}' is not in allowedVmSizes.`,
        hint: `Pick one of: ${allowed.join(", ")}`,
      }),
    )
  }

  const badSecret = i.envEntries
    .filter((e) => e.kind === "secret")
    .map((e) =>
      azureSecretNameProblem((e as { secretName: string }).secretName),
    )
    .find((p) => p !== undefined)
  if (badSecret !== undefined) {
    return Either.left(
      new UserError({
        message: badSecret,
        hint: "Rename it with `afk secrets put` and update .afk.env.",
      }),
    )
  }

  const mainService = config.mainService ?? DEFAULT_MAIN_SERVICE
  const built = input.built
  const assembled = assembleRunPlan({
    config,
    envEntries: i.envEntries,
    built,
    ref: input.ref,
    timeoutHours: input.timeoutHours,
    mainService,
    backend: "azure",
    composeContent: i.composeContent,
    runId: i.runId,
  })
  if (assembled.composeError) {
    return Either.left(new UserError({ message: assembled.composeError }))
  }
  const { timeoutHours, timeoutSeconds, env, secrets, composeUsed } = assembled

  const submittedBy = input.submittedBy ?? i.owner
  const name = vmName(i.sourceRepoName, i.runId)

  const customData = buildAzureCustomData({
    runId: i.runId,
    mainService,
    image: built.image,
    command: input.command,
    timeoutSeconds,
    retain,
    env,
    secretEnvNames: secrets,
    compose: assembled.composeContent,
    registry: names.registry,
    keyVault: names.keyVault,
    storageAccount: names.storageAccount,
    sessionArtifactBases: collectionBases(config.sessionArtifacts ?? []),
    sessionArtifactPrefix: `${i.sourceRepoName}/${i.runId}/session-artifacts/`,
    sessionArtifactMaxBytes: SESSION_ARTIFACT_MAX_BYTES,
  })

  const tags: Record<string, string> = {
    [AZURE_TAG_OWNER]: tagValue(i.owner),
    [AZURE_TAG_SUBMITTED_BY]: tagValue(submittedBy),
    [AZURE_TAG_RUN_ID]: i.runId,
    [AZURE_TAG_BRANCH]: tagValue(built.branch),
    [AZURE_TAG_SHA]: built.sha,
    [AZURE_TAG_MANAGED]: "true",
    [AZURE_TAG_REPO]: tagValue(i.sourceRepoName),
    [AZURE_TAG_TIMEOUT_HOURS]: String(timeoutHours),
    [AZURE_TAG_STARTED_AT]: i.startedAt,
    ...(retain ? { [AZURE_TAG_RETAIN]: "true" } : {}),
  }

  const backendPlan: AzureBackendPlan = {
    resourceGroup: coords.resourceGroup,
    location: coords.location,
    vmName: name,
    vmSize,
    imageId: i.goldenImageId,
    osDiskSizeGb: config.azure?.osDiskSizeGb,
    spot,
    retain,
    subnetId: names.subnetId,
    identityId: names.identityId,
    adminSshPublicKey: i.adminSshPublicKey,
    tags,
    customData,
    imageWasSkipped: built.skipped,
    startedAt: i.startedAt,
  }

  return Either.right({
    warnings: assembled.warnings,
    prepared: {
      runId: i.runId,
      command: input.command,
      image: built.image,
      branch: built.branch,
      sha: built.sha,
      composeUsed,
      mainService,
      timeoutHours,
      timeoutSeconds,
      owner: i.owner,
      submittedBy,
      repoName: i.sourceRepoName,
      env,
      secrets,
      logChannel: `Blob storage (${names.storageAccount}/afk-logs/${i.runId})`,
      backendPlan,
    },
  })
}

/** The neutral RunStarted a launched VM maps to. Pure. */
export const toRunStarted = (
  plan: PreparedRun,
  azure: AzureBackendPlan,
): RunStarted => ({
  runId: plan.runId,
  resourceId: azure.vmName,
  image: plan.image,
  branch: plan.branch,
  sha: plan.sha,
  composeUsed: plan.composeUsed,
  backendDetails: {
    vmSize: azure.vmSize,
    location: azure.location,
    spot: String(azure.spot),
    vmName: azure.vmName,
  },
  logChannel: plan.logChannel,
})
