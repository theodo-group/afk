import { Layer } from "effect"
import { GcpComputeLive } from "./GcpCompute.ts"
import { GcpImageRegistryLive } from "./GcpImageRegistry.ts"
import { GcpSecretStoreLive } from "./GcpSecretStore.ts"
import { GcpLogStoreLive } from "./GcpLogStore.ts"
import { GcpSessionArtifactStoreLive } from "./GcpSessionArtifactStore.ts"
import { GcpRunHistoryLive } from "./GcpRunHistory.ts"
import { GcpGoldenImageLive } from "./GcpGoldenImage.ts"
import { GcpBackendDoctorLive } from "./GcpBackendDoctor.ts"
import { GcpTeamLive } from "./GcpTeam.ts"
import { GcpProvisionerLive } from "./GcpProvisioner.ts"

/**
 * Aggregate Layer wiring every Backend service tag with the GCP implementation.
 * Selected by `cli.ts` when `afk.config.json` has `backend: "gcp"`. Mirrors
 * `backends/aws/index.ts`: `GcpComputeLive` consumes the `RunHistory` and
 * `GoldenImageStore` tags internally (to record Run starts in Firestore and to
 * boot from the latest Golden custom image), so the leaves are provided *into*
 * it via `provideMerge` while staying re-exported for the command layer.
 */
const Leaves = Layer.mergeAll(
  GcpImageRegistryLive,
  GcpSecretStoreLive,
  GcpLogStoreLive,
  GcpSessionArtifactStoreLive,
  GcpRunHistoryLive,
  GcpGoldenImageLive,
  GcpBackendDoctorLive,
  GcpTeamLive,
  GcpProvisionerLive,
)

export const GcpBackendLive = GcpComputeLive.pipe(Layer.provideMerge(Leaves))
