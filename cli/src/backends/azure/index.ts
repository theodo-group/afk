import { Layer } from "effect"
import { AzureComputeLive } from "./AzureCompute.ts"
import { AzureImageRegistryLive } from "./AzureImageRegistry.ts"
import { AzureSecretStoreLive } from "./AzureSecretStore.ts"
import { AzureLogStoreLive } from "./AzureLogStore.ts"
import { AzureSessionArtifactStoreLive } from "./AzureSessionArtifactStore.ts"
import { AzureRunHistoryLive } from "./AzureRunHistory.ts"
import { AzureGoldenImageLive } from "./AzureGoldenImage.ts"
import { AzureBackendDoctorLive } from "./AzureBackendDoctor.ts"
import { AzureTeamLive } from "./AzureTeam.ts"
import { AzureProvisionerLive } from "./AzureProvisioner.ts"
import { AzureScheduleStoreLive } from "./AzureScheduleStore.ts"

/**
 * Aggregate Layer wiring every Backend service tag with the Azure
 * implementation. Selected by `cli.ts` when `afk.config.json` has
 * `backend: "azure"`. Mirrors `backends/gcp/index.ts`: `AzureComputeLive`
 * consumes `RunHistory` and `GoldenImageStore`, so the leaves are provided
 * *into* it via `provideMerge` while staying re-exported for the commands.
 */
const Leaves = Layer.mergeAll(
  AzureImageRegistryLive,
  AzureSecretStoreLive,
  AzureLogStoreLive,
  AzureSessionArtifactStoreLive,
  AzureRunHistoryLive,
  AzureGoldenImageLive,
  AzureBackendDoctorLive,
  AzureTeamLive,
  AzureProvisionerLive,
  AzureScheduleStoreLive,
)

export const AzureBackendLive = AzureComputeLive.pipe(
  Layer.provideMerge(Leaves),
)
