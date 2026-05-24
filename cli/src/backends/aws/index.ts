import { Layer } from "effect"
import { AwsComputeLive } from "./AwsCompute.ts"
import { AwsImageRegistryLive } from "./AwsImageRegistry.ts"
import { AwsSecretStoreLive } from "./AwsSecretStore.ts"
import { AwsLogStoreLive } from "./AwsLogStore.ts"
import { AwsRunHistoryLive } from "./AwsRunHistory.ts"
import { AwsGoldenImageLive } from "./AwsGoldenImage.ts"
import { AwsBackendDoctorLive } from "./AwsBackendDoctor.ts"
import { AwsTeamLive } from "./AwsTeam.ts"
import { AwsProvisionerLive } from "./AwsProvisioner.ts"

/**
 * Aggregate Layer that wires up every Backend service tag with the AWS
 * implementation. Selected by `cli.ts` when `afk.config.json` has
 * `backend: "aws"` (the default).
 *
 * AwsComputeLive consumes the `RunHistory` and `GoldenImageStore` tags
 * internally (to record Run starts in DynamoDB and to boot from the latest
 * Golden AMI). The leaf adapters that provide those tags are wired via
 * `provideMerge`: they are provided as input to AwsComputeLive while still being
 * re-exported in the aggregate output so the command layer (the `secrets` and
 * `golden` commands) can consume SecretStore / GoldenImageStore directly.
 */
const Leaves = Layer.mergeAll(
  AwsImageRegistryLive,
  AwsSecretStoreLive,
  AwsLogStoreLive,
  AwsRunHistoryLive,
  AwsGoldenImageLive,
  AwsBackendDoctorLive,
  AwsTeamLive,
  AwsProvisionerLive,
)

export const AwsBackendLive = AwsComputeLive.pipe(Layer.provideMerge(Leaves))
