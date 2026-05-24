import { Either } from "effect"
import type { Tag as Ec2Tag } from "../../adapters/aws/Ec2.ts"
import type { AfkConfig, EnvEntry } from "../../schema/Config.ts"
import type { Run, RunStatus } from "../../schema/Run.ts"
import type {
  PreparedRun,
  RunStarted,
  StartInput,
} from "../../services/backend/Compute.ts"
import { UserError } from "../../infra/Errors.ts"
import { assembleRunPlan } from "../../services/RunPlan.ts"
import { buildUserData } from "../../services/UserData.ts"
import { collectionBases } from "../../services/SessionArtifact.ts"
import {
  AFK_ARTIFACTS_BUCKET_PREFIX,
  DEFAULT_INSTANCE_TYPE,
  DEFAULT_MAIN_SERVICE,
  DEFAULT_REGION,
  LOG_GROUP_PREFIX,
  SESSION_ARTIFACT_MAX_BYTES,
  TAG_BRANCH,
  TAG_MANAGED,
  TAG_OWNER,
  TAG_REPO,
  TAG_RUN_ID,
  TAG_SHA,
  TAG_STARTED_AT,
  TAG_TIMEOUT_HOURS,
} from "../../constants.ts"

// ---------------------------------------------------------------------------
// Functional core for the AWS Backend: pure, no I/O, no clock, no randomness.
// The shell (`AwsCompute`) gathers effectful inputs (config, STS identity,
// Golden Image, compose file, network placement), injects the non-deterministic
// seeds (`runId`, `startedAt`), and translates the returned data — `Either` for
// validation failures, `warnings` for non-fatal findings — into the Effect
// channel. Everything here is testable with plain assertions, no Layer.
// ---------------------------------------------------------------------------

const mapEc2State = (s: string): RunStatus => {
  switch (s) {
    case "pending":
      return "PROVISIONING"
    case "running":
      return "RUNNING"
    case "shutting-down":
    case "stopping":
      return "STOPPING"
    case "stopped":
    case "terminated":
    default:
      return "STOPPED"
  }
}

const tagsToMap = (tags: ReadonlyArray<Ec2Tag>): Record<string, string> =>
  Object.fromEntries(tags.map((t) => [t.key, t.value]))

export const ec2InstanceToRun = (i: {
  instanceId: string
  state: string
  instanceType: string
  launchTime?: string
  imageId: string
  spotInstanceRequestId?: string
  stateReason?: string
  tags: ReadonlyArray<Ec2Tag>
}): Run | null => {
  const m = tagsToMap(i.tags)
  const runId = m[TAG_RUN_ID]
  const owner = m[TAG_OWNER]
  if (!runId || !owner) return null
  const spot = Boolean(i.spotInstanceRequestId)
  return {
    runId: runId as Run["runId"],
    resourceId: i.instanceId,
    status: mapEc2State(i.state),
    backend: "aws",
    owner,
    branch: m[TAG_BRANCH] ?? "",
    sha: m[TAG_SHA] ?? "",
    image: i.imageId,
    backendDetails: {
      instanceType: i.instanceType,
      spot: String(spot),
    },
    startedAt: m[TAG_STARTED_AT] ?? i.launchTime,
    stoppedAt: undefined,
    stopReason: i.stateReason,
  }
}

/**
 * Provider-specific launch description, carried opaquely in
 * `PreparedRun.backendPlan` (a `Record<string, unknown>`). Declared as a closed
 * `type` rather than an `interface` so it is assignable to that record without a
 * cast — an interface could be augmented via declaration merging, so TS refuses
 * the assignment; a type alias is closed and assigns directly.
 */
export type AwsBackendPlan = {
  readonly region: string
  readonly accountId: string
  readonly amiId: string
  readonly instanceType: string
  readonly spot: boolean
  readonly subnetIds: ReadonlyArray<string>
  readonly securityGroupId: string
  readonly tags: ReadonlyArray<Ec2Tag>
  readonly userData: string
  readonly imageWasSkipped: boolean
  readonly startedAt: string
}

export interface PlanAwsRunInput {
  readonly config: AfkConfig
  readonly envEntries: ReadonlyArray<EnvEntry>
  readonly sourceRepoName: string
  readonly identity: { readonly Account: string; readonly UserId: string }
  readonly latestGoldenId: string
  /** Raw `afk.compose.yml`, pre-read by the shell; absent when none. */
  readonly composeContent: string | undefined
  readonly input: StartInput
  /** Injected by the shell — keeps the core deterministic. */
  readonly runId: string
  readonly startedAt: string
}

/**
 * The Run Plan minus the bits the shell must still fetch (network placement)
 * and act on (warnings, ensuring the log group). `region` and `logChannel` are
 * surfaced so the shell can drive those effects without re-deriving them.
 */
export interface AwsRunCore {
  readonly region: string
  readonly warnings: ReadonlyArray<string>
  readonly preparedBase: Omit<PreparedRun, "backendPlan">
  readonly backendPlanBase: Omit<
    AwsBackendPlan,
    "subnetIds" | "securityGroupId"
  >
}

/** Resolve a StartInput into the AWS Run Plan core, or a UserError describing
 *  why it cannot launch. Pure. */
export const planAwsRun = (
  i: PlanAwsRunInput,
): Either.Either<AwsRunCore, UserError> => {
  const { config, identity, input } = i
  const region = config.aws?.region ?? DEFAULT_REGION

  const instanceTypeOverride =
    typeof input.backendOverrides?.instanceType === "string"
      ? input.backendOverrides.instanceType
      : undefined
  const instanceType =
    instanceTypeOverride ??
    config.aws?.defaultInstanceType ??
    config.defaultInstanceType ??
    DEFAULT_INSTANCE_TYPE
  const whitelist =
    config.aws?.allowedInstanceTypes ?? config.allowedInstanceTypes
  if (whitelist && whitelist.length > 0 && !whitelist.includes(instanceType)) {
    return Either.left(
      new UserError({
        message: `Instance type '${instanceType}' is not in allowedInstanceTypes.`,
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
    backend: "aws",
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

  const logGroup = `${LOG_GROUP_PREFIX}/${i.sourceRepoName}`

  const userData = buildUserData({
    runId: i.runId,
    region,
    accountId: identity.Account,
    repoName: i.sourceRepoName,
    mainService,
    image: built.image,
    command: input.command,
    timeoutSeconds,
    env,
    // UserData still expects {name, ssmName} for back-compat with the AWS
    // entrypoint which dereferences via the VM's instance profile.
    secrets: secrets.map((s) => ({
      name: s.name,
      ssmName: `/afk/secrets/${s.secretName}`,
    })),
    compose: composeContent,
    sessionArtifactBases: collectionBases(config.sessionArtifacts ?? []),
    sessionArtifactBucket: `${AFK_ARTIFACTS_BUCKET_PREFIX}-${identity.Account}-${region}`,
    sessionArtifactMaxBytes: SESSION_ARTIFACT_MAX_BYTES,
  })

  const onDemandOverride =
    input.backendOverrides?.onDemand === true ||
    input.backendOverrides?.onDemand === "true"
  const spot = !onDemandOverride

  const tags: ReadonlyArray<Ec2Tag> = [
    { key: TAG_OWNER, value: identity.UserId },
    { key: TAG_RUN_ID, value: i.runId },
    { key: TAG_BRANCH, value: built.branch },
    { key: TAG_SHA, value: built.sha },
    { key: TAG_MANAGED, value: "true" },
    { key: TAG_REPO, value: i.sourceRepoName },
    { key: TAG_TIMEOUT_HOURS, value: String(timeoutHours) },
    { key: TAG_STARTED_AT, value: i.startedAt },
    { key: "Name", value: `afk-${i.sourceRepoName}-${i.runId.slice(0, 8)}` },
  ]

  return Either.right({
    region,
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
      owner: identity.UserId,
      repoName: i.sourceRepoName,
      env,
      secrets,
      logChannel: logGroup,
    },
    backendPlanBase: {
      region,
      accountId: identity.Account,
      amiId: i.latestGoldenId,
      instanceType,
      spot,
      tags,
      userData,
      imageWasSkipped: built.skipped,
      startedAt: i.startedAt,
    },
  })
}

/** Attach the fetched network placement to a core, producing the final
 *  PreparedRun the shell returns. Pure. */
export const finalizeAwsPlan = (
  core: AwsRunCore,
  placement: {
    readonly subnetIds: ReadonlyArray<string>
    readonly securityGroupId: string
  },
): PreparedRun => {
  const backendPlan: AwsBackendPlan = {
    ...core.backendPlanBase,
    subnetIds: placement.subnetIds,
    securityGroupId: placement.securityGroupId,
  }
  return { ...core.preparedBase, backendPlan }
}

/** The neutral RunStarted a launched instance maps to. Pure. */
export const toRunStarted = (
  plan: PreparedRun,
  aws: AwsBackendPlan,
  instanceId: string,
): RunStarted => ({
  runId: plan.runId,
  resourceId: instanceId,
  image: plan.image,
  branch: plan.branch,
  sha: plan.sha,
  composeUsed: plan.composeUsed,
  backendDetails: {
    instanceType: aws.instanceType,
    spot: String(aws.spot),
    instanceId,
  },
  logChannel: plan.logChannel,
})
