import { Layer } from "effect"
import { AwsComputeLive } from "./AwsCompute.ts"
import { AwsImageRegistryLive } from "./AwsImageRegistry.ts"
import { AwsSecretStoreLive } from "./AwsSecretStore.ts"
import { AwsLogStoreLive } from "./AwsLogStore.ts"
import { AwsRunHistoryLive } from "./AwsRunHistory.ts"

/**
 * Aggregate Layer that wires up every Backend service tag with the AWS
 * implementation. Selected by `cli.ts` when `afk.config.json` has
 * `backend: "aws"` (the default).
 *
 * AwsComputeLive consumes the `RunHistory` tag internally to record Run starts
 * in DynamoDB. AwsRunHistoryLive provides that tag. To satisfy the intra-merge
 * dependency we wire them via `provideMerge`: AwsRunHistoryLive (and the other
 * leaf adapters that have no intra-backend deps) is provided as input to
 * AwsComputeLive, while still being re-exported in the aggregate output so
 * other services (e.g. SecretService) can consume SecretStore directly.
 */
const Leaves = Layer.mergeAll(
  AwsImageRegistryLive,
  AwsSecretStoreLive,
  AwsLogStoreLive,
  AwsRunHistoryLive,
)

export const AwsBackendLive = AwsComputeLive.pipe(Layer.provideMerge(Leaves))
