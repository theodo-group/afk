import { Effect, Layer } from "effect"
import { ScheduleStore } from "../../services/backend/ScheduleStore.ts"
import { UserError } from "../../infra/Errors.ts"

/**
 * The Azure Backend has no Schedule store yet. The Scheduler ships on AWS
 * only; this keeps the tag resolved so the `afk schedule` commands compile
 * against one neutral seam, and refuses with the reason (docs/architecture.md).
 */
const unsupported = Effect.fail(
  new UserError({
    message: "Schedules are not supported on the Azure Backend.",
    hint: "The scheduler runs on the AWS Backend today. Submit the Schedule there, or launch Runs by hand with `afk run`.",
  }),
)

export const AzureScheduleStoreLive = Layer.succeed(
  ScheduleStore,
  ScheduleStore.of({
    replace: () => unsupported,
    list: () => unsupported,
    markLaunched: () => unsupported,
    markSettled: () => unsupported,
    recordLaunchFailure: () => unsupported,
    rearm: () => unsupported,
    cancel: () => unsupported,
  }),
)
