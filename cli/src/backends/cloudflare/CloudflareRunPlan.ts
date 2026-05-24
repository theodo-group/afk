import { Either } from "effect"
import type { AfkConfig, EnvEntry } from "../../schema/Config.ts"
import type { Run, RunStatus } from "../../schema/Run.ts"
import type {
  PreparedRun,
  RunStarted,
  StartInput,
} from "../../services/backend/Compute.ts"
import { UserError } from "../../infra/Errors.ts"
import { assembleRunPlan } from "../../services/RunPlan.ts"
import { collectionBases } from "../../services/SessionArtifact.ts"
import {
  DEFAULT_MAIN_SERVICE,
  SESSION_ARTIFACT_MAX_BYTES,
} from "../../constants.ts"

// ---------------------------------------------------------------------------
// Functional core for the Cloudflare Backend: pure, no I/O, no clock, no
// randomness. The shell (`CloudflareCompute`) gathers effectful inputs (config,
// worker URL, Golden Image, compose file, caller principal), injects the
// non-deterministic seeds (`runId`, `startedAt`), and translates the returned
// data — `Either` for validation failures, `warnings` for non-fatal findings —
// into the Effect channel. Everything here is testable with plain assertions,
// no Layer.
// ---------------------------------------------------------------------------

const DEFAULT_INSTANCE_TIER = "standard-1"

const mapStatus = (s: string): RunStatus => {
  switch (s) {
    case "PROVISIONING":
      return "PROVISIONING"
    case "RUNNING":
      return "RUNNING"
    case "STOPPING":
      return "STOPPING"
    default:
      return "STOPPED"
  }
}

export interface RunMetadataWire {
  readonly runId: string
  readonly owner: string
  readonly branch: string
  readonly sha: string
  readonly image: string
  readonly repoName: string
  readonly startedAt: string
  readonly timeoutHours: number
  readonly status: "PROVISIONING" | "RUNNING" | "STOPPING" | "STOPPED"
  readonly mainService: string
  readonly instanceTier: string
  readonly resourceId?: string
  readonly stoppedAt?: string
  readonly exitCode?: number
  readonly stopReason?: string
}

export const wireToRun = (m: RunMetadataWire): Run => ({
  runId: m.runId as Run["runId"],
  resourceId: m.resourceId ?? m.runId,
  status: mapStatus(m.status),
  backend: "cloudflare",
  owner: m.owner,
  branch: m.branch,
  sha: m.sha,
  image: m.image,
  backendDetails: {
    instanceTier: m.instanceTier,
    mainService: m.mainService,
  },
  startedAt: m.startedAt,
  ...(m.stoppedAt !== undefined ? { stoppedAt: m.stoppedAt } : {}),
  ...(m.stopReason !== undefined ? { stopReason: m.stopReason } : {}),
})

/**
 * Provider-specific launch description, carried opaquely in
 * `PreparedRun.backendPlan` (a `Record<string, unknown>`). Declared as a closed
 * `type` rather than an `interface` so it is assignable to that record without a
 * cast — an interface could be augmented via declaration merging, so TS refuses
 * the assignment; a type alias is closed and assigns directly.
 */
export type CloudflareBackendPlan = {
  readonly workerUrl: string
  readonly instanceTier: string
  readonly accountId?: string
  readonly startedAt: string
  readonly composeContent?: string
  readonly sessionArtifactBases: ReadonlyArray<string>
}

export interface PlanCloudflareRunInput {
  readonly config: AfkConfig
  readonly envEntries: ReadonlyArray<EnvEntry>
  readonly sourceRepoName: string
  readonly workerUrl: string
  /** Caller principal (CF Access client-id, or "local" in single-dev mode). */
  readonly principalId: string
  readonly composeContent: string | undefined
  readonly input: StartInput
  /** Injected by the shell — keeps the core deterministic. */
  readonly runId: string
  readonly startedAt: string
}

/** The resolved Run Plan plus the non-fatal warnings the shell must print. */
export interface CloudflareRunCore {
  readonly warnings: ReadonlyArray<string>
  readonly prepared: PreparedRun
}

/** Resolve a StartInput into the Cloudflare Run Plan, or a UserError describing
 *  why it cannot launch. Pure. */
export const planCloudflareRun = (
  i: PlanCloudflareRunInput,
): Either.Either<CloudflareRunCore, UserError> => {
  const { config, input } = i
  const built = input.built
  const mainService = config.mainService ?? DEFAULT_MAIN_SERVICE

  const tierOverride =
    typeof input.backendOverrides?.instanceType === "string"
      ? input.backendOverrides.instanceType
      : undefined
  const instanceTier =
    tierOverride ??
    config.cloudflare?.defaultInstanceTier ??
    config.defaultInstanceType ??
    DEFAULT_INSTANCE_TIER

  const assembled = assembleRunPlan({
    config,
    envEntries: i.envEntries,
    built,
    ref: input.ref,
    timeoutHours: input.timeoutHours,
    mainService,
    backend: "cloudflare",
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

  const backendPlan: CloudflareBackendPlan = {
    workerUrl: i.workerUrl,
    instanceTier,
    ...(config.cloudflare?.accountId !== undefined
      ? { accountId: config.cloudflare.accountId }
      : {}),
    startedAt: i.startedAt,
    ...(composeContent !== undefined ? { composeContent } : {}),
    sessionArtifactBases: collectionBases(config.sessionArtifacts ?? []),
  }

  const prepared: PreparedRun = {
    runId: i.runId,
    command: input.command,
    image: built.image,
    branch: built.branch,
    sha: built.sha,
    composeUsed,
    mainService,
    timeoutHours,
    timeoutSeconds,
    owner: i.principalId,
    repoName: i.sourceRepoName,
    env,
    secrets,
    logChannel: `Workers Logs (runId=${i.runId})`,
    backendPlan,
  }

  return Either.right({ warnings: assembled.warnings, prepared })
}

/** The launcher Worker's start-request body for a prepared plan. Pure. */
export const toStartRequest = (
  plan: PreparedRun,
  cf: CloudflareBackendPlan,
) => ({
  runId: plan.runId,
  command: plan.command,
  timeoutHours: plan.timeoutHours,
  image: plan.image,
  branch: plan.branch,
  sha: plan.sha,
  mainService: plan.mainService,
  repoName: plan.repoName,
  env: plan.env,
  secretNames: plan.secrets,
  ...(cf.composeContent !== undefined ? { compose: cf.composeContent } : {}),
  instanceTier: cf.instanceTier,
  ...(cf.sessionArtifactBases.length > 0
    ? {
        sessionArtifactBases: cf.sessionArtifactBases,
        sessionArtifactMaxBytes: SESSION_ARTIFACT_MAX_BYTES,
      }
    : {}),
  // So the container can POST its completion callback (logs + exit) back.
  workerUrl: cf.workerUrl,
})

/** The neutral RunStarted a launched Container maps to. Pure. */
export const toRunStarted = (
  plan: PreparedRun,
  cf: CloudflareBackendPlan,
  resourceId: string,
): RunStarted => ({
  runId: plan.runId,
  resourceId,
  image: plan.image,
  branch: plan.branch,
  sha: plan.sha,
  composeUsed: plan.composeUsed,
  backendDetails: {
    instanceTier: cf.instanceTier,
    mainService: plan.mainService,
  },
  logChannel: plan.logChannel,
})
