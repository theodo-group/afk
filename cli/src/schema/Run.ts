import { Schema } from "effect"

export const RunId = Schema.String.pipe(Schema.brand("RunId"))
export type RunId = typeof RunId.Type

/**
 * Status of a Run, mapped from the underlying EC2 instance state.
 * EC2 states: pending | running | shutting-down | stopping | stopped | terminated
 * We collapse "stopped" and "terminated" into STOPPED, and bucket transitional
 * states accordingly.
 */
export const RunStatus = Schema.Literal(
  "PROVISIONING", // pending
  "RUNNING", // running
  "STOPPING", // shutting-down | stopping
  "STOPPED", // stopped | terminated
)
export type RunStatus = typeof RunStatus.Type

export const Run = Schema.Struct({
  runId: RunId,
  instanceId: Schema.String,
  status: RunStatus,
  owner: Schema.String,
  branch: Schema.String,
  sha: Schema.String,
  image: Schema.String,
  instanceType: Schema.String,
  spot: Schema.Boolean,
  startedAt: Schema.optional(Schema.String),
  stoppedAt: Schema.optional(Schema.String),
  stopReason: Schema.optional(Schema.String),
})
export type Run = typeof Run.Type
