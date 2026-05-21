import { Schema } from "effect"

export const RunId = Schema.String.pipe(Schema.brand("RunId"))
export type RunId = typeof RunId.Type

export const RunStatus = Schema.Literal(
  "PROVISIONING",
  "PENDING",
  "RUNNING",
  "STOPPING",
  "STOPPED",
  "DEPROVISIONING",
)
export type RunStatus = typeof RunStatus.Type

export const Run = Schema.Struct({
  runId: RunId,
  taskArn: Schema.String,
  status: RunStatus,
  owner: Schema.String,
  branch: Schema.String,
  sha: Schema.String,
  image: Schema.String,
  cpu: Schema.Number,
  memory: Schema.Number,
  startedAt: Schema.optional(Schema.String),
  stoppedAt: Schema.optional(Schema.String),
  stopReason: Schema.optional(Schema.String),
})
export type Run = typeof Run.Type
