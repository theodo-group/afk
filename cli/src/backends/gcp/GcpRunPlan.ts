import { Either } from "effect"
import type { Label } from "../../adapters/gcp/Gce.ts"
import type { AfkConfig, EnvEntry } from "../../schema/Config.ts"
import type { Run, RunStatus } from "../../schema/Run.ts"
import type {
  PreparedRun,
  RunStarted,
  StartInput,
} from "../../services/backend/Compute.ts"
import { UserError } from "../../infra/Errors.ts"
import { assembleRunPlan } from "../../services/RunPlan.ts"
import { buildStartupScript } from "./GcpStartupScript.ts"
import { collectionBases } from "../../services/SessionArtifact.ts"
import {
  GCP_ARTIFACTS_BUCKET_PREFIX,
  GCP_DEFAULT_MACHINE_TYPE,
  GCP_DEFAULT_REGION,
  GCP_DEFAULT_ZONE,
  GCP_LABEL_BRANCH,
  GCP_LABEL_MANAGED,
  GCP_LABEL_OWNER,
  GCP_LABEL_REPO,
  GCP_LABEL_RUN_ID,
  GCP_LABEL_SHA,
  GCP_LABEL_STARTED_AT,
  GCP_LABEL_TIMEOUT_HOURS,
  GCP_LABEL_VALUE_MAX,
  DEFAULT_MAIN_SERVICE,
  SESSION_ARTIFACT_MAX_BYTES,
} from "../../constants.ts"

// ---------------------------------------------------------------------------
// Functional core for the GCP Backend: pure, no I/O, no clock, no randomness.
// The shell (`GcpCompute`) gathers effectful inputs (config, gcloud identity,
// Golden Image, compose file, network placement), injects the non-deterministic
// seeds (`runId`, `startedAt`), and translates the returned data — `Either` for
// validation failures, `warnings` for non-fatal findings — into the Effect
// channel. Mirrors `AwsRunPlan.ts`, the functional-core/imperative-shell
// exemplar. GCP reclaims immediately, so there is no retention (no
// `retainedUntil`).
// ---------------------------------------------------------------------------

const mapGceStatus = (s: string): RunStatus => {
  switch (s) {
    case "PROVISIONING":
    case "STAGING":
      return "PROVISIONING"
    case "RUNNING":
      return "RUNNING"
    case "STOPPING":
    case "SUSPENDING":
      return "STOPPING"
    default:
      return "STOPPED"
  }
}

/**
 * Sanitize a value to the GCE label charset: lowercase, `@`/`.`/`/` and any
 * other disallowed character collapsed to `-`, capped at 63 chars. The raw
 * value (e.g. the full owner email) is preserved in the Firestore history row;
 * the label is only the scoping key.
 */
export const sanitizeLabel = (raw: string): string =>
  raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .slice(0, GCP_LABEL_VALUE_MAX)

const labelsToMap = (labels: ReadonlyArray<Label>): Record<string, string> =>
  Object.fromEntries(labels.map((l) => [l.key, l.value]))

export const gceInstanceToRun = (i: {
  name: string
  id: string
  status: string
  machineType: string
  zone: string
  creationTimestamp?: string
  labels: ReadonlyArray<Label>
}): Run | null => {
  const m = labelsToMap(i.labels)
  const runId = m[GCP_LABEL_RUN_ID]
  const owner = m[GCP_LABEL_OWNER]
  if (!runId || !owner) return null
  return {
    runId: runId as Run["runId"],
    resourceId: i.name,
    status: mapGceStatus(i.status),
    backend: "gcp",
    owner,
    branch: m[GCP_LABEL_BRANCH] ?? "",
    sha: m[GCP_LABEL_SHA] ?? "",
    image: i.machineType,
    backendDetails: {
      machineType: i.machineType,
      zone: i.zone,
    },
    startedAt: m[GCP_LABEL_STARTED_AT] ?? i.creationTimestamp,
    stoppedAt: undefined,
    stopReason: undefined,
  }
}

/**
 * Provider-specific launch description, carried opaquely in
 * `PreparedRun.backendPlan` (a `Record<string, unknown>`). A closed `type`, not
 * an `interface`, so it is assignable to that record without a double cast
 * (code-style.md §4).
 */
export type GcpBackendPlan = {
  readonly project: string
  readonly region: string
  readonly zone: string
  readonly imageFamily: string
  readonly machineType: string
  /** Spot (`provisioningModel: SPOT`) vs On-Demand (`STANDARD`). */
  readonly spot: boolean
  readonly serviceAccount: string
  readonly instanceName: string
  readonly maxRunDurationSeconds: number
  readonly subnet: string
  readonly labels: ReadonlyArray<Label>
  readonly startupScript: string
  readonly imageWasSkipped: boolean
  readonly startedAt: string
}

export interface PlanGcpRunInput {
  readonly config: AfkConfig
  readonly envEntries: ReadonlyArray<EnvEntry>
  readonly sourceRepoName: string
  readonly project: string
  readonly ownerAccount: string
  /** The Golden custom-image family the Run boots from. */
  readonly goldenImageFamily: string
  /** Raw `afk.compose.yml`, pre-read by the shell; absent when none. */
  readonly composeContent: string | undefined
  readonly input: StartInput
  /** Injected by the shell — keeps the core deterministic. */
  readonly runId: string
  readonly startedAt: string
}

/**
 * The Run Plan minus the bits the shell must still fetch (network placement)
 * and act on (warnings). `region`/`zone` are surfaced so the shell can drive
 * those effects without re-deriving them.
 */
export interface GcpRunCore {
  readonly region: string
  readonly zone: string
  readonly project: string
  readonly warnings: ReadonlyArray<string>
  readonly preparedBase: Omit<PreparedRun, "backendPlan">
  readonly backendPlanBase: Omit<GcpBackendPlan, "subnet">
}

/** Resolve a StartInput into the GCP Run Plan core, or a UserError describing
 *  why it cannot launch. Pure. */
export const planGcpRun = (
  i: PlanGcpRunInput,
): Either.Either<GcpRunCore, UserError> => {
  const { config, input } = i
  const region = config.gcp?.region ?? GCP_DEFAULT_REGION
  const zone = config.gcp?.zone ?? GCP_DEFAULT_ZONE

  // The neutral `--instance-type` flag (RunService → backendOverrides) is the
  // cross-backend "size" selector; on GCP its value space is machine types.
  const machineTypeOverride =
    typeof input.backendOverrides?.instanceType === "string"
      ? input.backendOverrides.instanceType
      : undefined
  const machineType =
    machineTypeOverride ??
    config.gcp?.defaultMachineType ??
    GCP_DEFAULT_MACHINE_TYPE

  // Spot is the default (cheaper); `--on-demand` opts up to STANDARD capacity for
  // interruption-resistance. Both DELETE on exit, so neither is retained.
  const onDemand =
    input.backendOverrides?.onDemand === true ||
    input.backendOverrides?.onDemand === "true"
  const spot = !onDemand
  const whitelist = config.gcp?.allowedMachineTypes
  if (whitelist && whitelist.length > 0 && !whitelist.includes(machineType)) {
    return Either.left(
      new UserError({
        message: `Machine type '${machineType}' is not in allowedMachineTypes.`,
        hint: `Pick one of: ${whitelist.join(", ")}`,
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
    backend: "gcp",
    composeContent: i.composeContent,
    runId: i.runId,
  })
  if (assembled.composeError) {
    return Either.left(new UserError({ message: assembled.composeError }))
  }
  const {
    timeoutHours,
    timeoutSeconds,
    env,
    secrets,
    composeContent,
    composeUsed,
  } = assembled

  const bucket = `${GCP_ARTIFACTS_BUCKET_PREFIX}-${i.project}`
  const instanceName = `afk-${i.sourceRepoName}-${i.runId.slice(0, 8)}`.slice(
    0,
    GCP_LABEL_VALUE_MAX,
  )
  const logChannel = `Cloud Logging (afk-run=${i.runId})`

  const startupScript = buildStartupScript({
    runId: i.runId,
    project: i.project,
    zone,
    instanceName,
    mainService,
    image: built.image,
    command: input.command,
    timeoutSeconds,
    env,
    secrets: secrets.map((s) => s.secretName),
    secretEnvNames: secrets.map((s) => ({
      name: s.name,
      secretName: s.secretName,
    })),
    compose: composeContent,
    sessionArtifactBases: collectionBases(config.sessionArtifacts ?? []),
    sessionArtifactBucket: bucket,
    sessionArtifactPrefix: `${i.sourceRepoName}/${i.runId}/session-artifacts/`,
    sessionArtifactMaxBytes: SESSION_ARTIFACT_MAX_BYTES,
  })

  const labels: ReadonlyArray<Label> = [
    { key: GCP_LABEL_OWNER, value: sanitizeLabel(i.ownerAccount) },
    { key: GCP_LABEL_RUN_ID, value: i.runId },
    { key: GCP_LABEL_BRANCH, value: sanitizeLabel(built.branch) },
    { key: GCP_LABEL_SHA, value: sanitizeLabel(built.sha) },
    { key: GCP_LABEL_MANAGED, value: "true" },
    { key: GCP_LABEL_REPO, value: sanitizeLabel(i.sourceRepoName) },
    { key: GCP_LABEL_TIMEOUT_HOURS, value: String(timeoutHours) },
    { key: GCP_LABEL_STARTED_AT, value: sanitizeLabel(i.startedAt) },
  ]

  return Either.right({
    region,
    zone,
    project: i.project,
    warnings: assembled.warnings,
    preparedBase: {
      runId: i.runId,
      command: input.command,
      image: built.image,
      branch: built.branch,
      sha: built.sha,
      composeUsed,
      mainService,
      timeoutHours,
      timeoutSeconds,
      owner: i.ownerAccount,
      repoName: i.sourceRepoName,
      env,
      secrets,
      logChannel,
    },
    backendPlanBase: {
      project: i.project,
      region,
      zone,
      imageFamily: i.goldenImageFamily,
      machineType,
      spot,
      serviceAccount: "",
      instanceName,
      maxRunDurationSeconds: timeoutSeconds,
      labels,
      startupScript,
      imageWasSkipped: built.skipped,
      startedAt: i.startedAt,
    },
  })
}

/** Attach the fetched network placement (subnet + the resolved instance service
 *  account) to a core, producing the final PreparedRun the shell returns. Pure. */
export const finalizeGcpPlan = (
  core: GcpRunCore,
  placement: {
    readonly subnet: string
    readonly serviceAccount: string
  },
): PreparedRun => {
  const backendPlan: GcpBackendPlan = {
    ...core.backendPlanBase,
    serviceAccount: placement.serviceAccount,
    subnet: placement.subnet,
  }
  return { ...core.preparedBase, backendPlan }
}

/** The neutral RunStarted a launched instance maps to. Pure. */
export const toRunStarted = (
  plan: PreparedRun,
  gcp: GcpBackendPlan,
  instanceName: string,
): RunStarted => ({
  runId: plan.runId,
  resourceId: instanceName,
  image: plan.image,
  branch: plan.branch,
  sha: plan.sha,
  composeUsed: plan.composeUsed,
  backendDetails: {
    machineType: gcp.machineType,
    zone: gcp.zone,
    instanceName,
  },
  logChannel: plan.logChannel,
})
