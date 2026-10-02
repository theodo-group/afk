import { Effect, Layer } from "effect"
import { ScheduleStore } from "../../services/backend/ScheduleStore.ts"
import { UserError } from "../../infra/Errors.ts"

/**
 * the GCP Backend has no Schedule store yet. The scheduler ships on AWS only; this
 * keeps the tag resolved so the `afk schedule` commands compile against one
 * Backend-neutral seam, and refuses with a message naming the reason rather
 * than failing deeper with a missing-service defect.
 */
const unsupported = Effect.fail(
  new UserError({
    message: "Schedules are not supported on the GCP Backend.",
    hint: "The scheduler runs on the AWS Backend today. Submit the Schedule there, or launch Runs by hand with `afk run`.",
  }),
)

export const GcpScheduleStoreLive = Layer.succeed(
  ScheduleStore,
  ScheduleStore.of({
    replace: () => unsupported,
    list: () => unsupported,
    markLaunched: () => unsupported,
    markSettled: () => unsupported,
    rearm: () => unsupported,
    cancel: () => unsupported,
  }),
)
