import type { AfkConfig, EnvEntry } from "../schema/Config.ts"
import { UserError } from "../infra/Errors.ts"
import { DEFAULT_TIMEOUT_HOURS } from "../constants.ts"
import { lintCompose, substituteImage } from "./Compose.ts"

/**
 * The Backend-neutral core of a [[Run Plan]]: everything resolving a developer's
 * request into a launch description that does NOT depend on the active Backend
 * — the timeout, the `AFK_*`-augmented env, the secret references, and the
 * linted compose graph. Each Backend's `Compute.prepare` calls `assembleRunPlan`
 * and then attaches only its provider-specific fields (owner, log channel,
 * backendPlan) on top.
 */
export interface AssembledRunPlan {
  readonly timeoutHours: number
  readonly timeoutSeconds: number
  readonly env: ReadonlyArray<{ readonly name: string; readonly value: string }>
  readonly secrets: ReadonlyArray<{
    readonly name: string
    readonly secretName: string
  }>
  readonly composeUsed: boolean
  /** Linted + image-substituted compose YAML; absent when no compose file. */
  readonly composeContent?: string
  /** Non-fatal lint findings the caller should surface to the developer. */
  readonly warnings: ReadonlyArray<string>
  /** Set when compose linting fails fatally; the caller raises it as a UserError. */
  readonly composeError?: string
}

export interface AssembleRunPlanInput {
  readonly config: AfkConfig
  readonly envEntries: ReadonlyArray<EnvEntry>
  readonly built: {
    readonly image: string
    readonly sha: string
    readonly branch: string
  }
  readonly ref?: string
  readonly timeoutHours?: number
  readonly mainService: string
  readonly backend: "aws" | "cloudflare"
  /** Raw `afk.compose.yml` content, pre-read by the caller; absent when none. */
  readonly composeContent?: string
  readonly runId: string
}

/**
 * Pure. No I/O, no clock, no randomness — the caller injects `runId` and the
 * already-read `composeContent`, and surfaces `warnings` / `composeError`. This
 * keeps the `AFK_*` env contract and secret mapping testable through plain
 * assertions, identically across every Backend.
 */
export const assembleRunPlan = (input: AssembleRunPlanInput): AssembledRunPlan => {
  const { config, envEntries, built, ref, mainService, backend, runId } = input

  const timeoutHours =
    input.timeoutHours ?? config.defaultTimeoutHours ?? DEFAULT_TIMEOUT_HOURS
  const timeoutSeconds = Math.floor(timeoutHours * 3600)

  const env: Array<{ name: string; value: string }> = envEntries
    .filter((e) => e.kind === "plain")
    .map((e) => ({ name: e.name, value: (e as { value: string }).value }))
  env.push({ name: "AFK_GIT_URL", value: config.gitUrl })
  env.push({ name: "AFK_GIT_SHA", value: built.sha })
  env.push({ name: "AFK_GIT_REF", value: ref ?? built.branch })
  env.push({ name: "AFK_RUN_ID", value: runId })
  env.push({ name: "AFK_TIMEOUT_SECONDS", value: String(timeoutSeconds) })

  const secrets = envEntries
    .filter((e) => e.kind === "secret")
    .map((e) => ({
      name: e.name,
      secretName: (e as { secretName: string }).secretName,
    }))

  const base = {
    timeoutHours,
    timeoutSeconds,
    env,
    secrets,
    composeUsed: input.composeContent !== undefined,
  }

  if (input.composeContent === undefined) {
    return { ...base, warnings: [] }
  }

  try {
    const lint = lintCompose({
      content: input.composeContent,
      mainService,
      backend,
    })
    return {
      ...base,
      composeContent: substituteImage(lint.content, built.image),
      warnings: lint.warnings,
    }
  } catch (e) {
    const message =
      e instanceof UserError ? e.message : `afk.compose.yml: ${String(e)}`
    return { ...base, warnings: [], composeError: message }
  }
}
