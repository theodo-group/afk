import { Either } from "effect"
import type { AfkConfig, EnvEntry } from "../../schema/Config.ts"
import type { PreparedRun, StartInput } from "../../services/backend/Compute.ts"
import { UserError } from "../../infra/Errors.ts"
import { assembleRunPlan } from "../../services/RunPlan.ts"
import { DEFAULT_MAIN_SERVICE, LOCAL_OWNER_ID } from "../../constants.ts"
import { runLogsDir } from "./localPaths.ts"

// ---------------------------------------------------------------------------
// Functional core for the Local Backend: pure, no I/O, no clock, no randomness.
// The shell (`LocalCompute`) gathers effectful inputs (config, Golden Image,
// compose file), injects the non-deterministic seeds (`runId`, `startedAt`),
// and translates the returned data — `Either` for validation failures,
// `warnings` for non-fatal findings — into the Effect channel. Everything here
// is testable with plain assertions, no Layer.
// ---------------------------------------------------------------------------

/**
 * Provider-specific launch description, carried opaquely in
 * `PreparedRun.backendPlan` (a `Record<string, unknown>`). Declared as a closed
 * `type` rather than an `interface` so it is assignable to that record without a
 * cast — an interface could be augmented via declaration merging, so TS refuses
 * the assignment; a type alias is closed and assigns directly.
 */
export type LocalBackendPlan = {
  readonly goldenImage: string
  readonly startedAt: string
  readonly composeContent?: string
}

export interface PlanLocalRunInput {
  readonly config: AfkConfig
  readonly envEntries: ReadonlyArray<EnvEntry>
  readonly sourceRepoName: string
  readonly goldenImageId: string
  /** Raw `afk.compose.yml`, pre-read by the shell; absent when none. */
  readonly composeContent: string | undefined
  readonly input: StartInput
  /** Injected by the shell — keeps the core deterministic. */
  readonly runId: string
  readonly startedAt: string
}

/**
 * The Local Run Plan plus the non-fatal lint findings the shell must still
 * surface. The shell warns on `warnings`, then returns `plan` unchanged.
 */
export interface LocalRunCore {
  readonly warnings: ReadonlyArray<string>
  readonly plan: PreparedRun
}

/** Resolve a StartInput into the Local Run Plan, or a UserError describing why
 *  it cannot launch. Pure. */
export const planLocalRun = (
  i: PlanLocalRunInput,
): Either.Either<LocalRunCore, UserError> => {
  const { config, input } = i
  const built = input.built
  const mainService = config.mainService ?? DEFAULT_MAIN_SERVICE

  const assembled = assembleRunPlan({
    config,
    envEntries: i.envEntries,
    built,
    ref: input.ref,
    timeoutHours: input.timeoutHours,
    mainService,
    backend: "local",
    composeContent: i.composeContent,
    runId: i.runId,
  })
  if (assembled.composeError) {
    return Either.left(new UserError({ message: assembled.composeError }))
  }
  const { timeoutHours, timeoutSeconds, env, secrets, composeContent, composeUsed } =
    assembled

  const backendPlan: LocalBackendPlan = {
    goldenImage: i.goldenImageId,
    startedAt: i.startedAt,
    ...(composeContent !== undefined ? { composeContent } : {}),
  }

  const plan: PreparedRun = {
    runId: i.runId,
    command: input.command,
    image: built.image,
    branch: built.branch,
    sha: built.sha,
    composeUsed,
    mainService,
    timeoutHours,
    timeoutSeconds,
    owner: LOCAL_OWNER_ID,
    repoName: i.sourceRepoName,
    env,
    secrets,
    logChannel: runLogsDir(i.runId),
    backendPlan,
  }

  return Either.right({ warnings: assembled.warnings, plan })
}
