import { Layer } from "effect"
import { CloudflareComputeLive } from "./CloudflareCompute.ts"
import { CloudflareImageRegistryLive } from "./CloudflareImageRegistry.ts"
import { CloudflareSecretStoreLive } from "./CloudflareSecretStore.ts"
import { CloudflareLogStoreLive } from "./CloudflareLogStore.ts"
import { CloudflareSessionArtifactStoreLive } from "./CloudflareSessionArtifactStore.ts"
import { CloudflareRunHistoryLive } from "./CloudflareRunHistory.ts"
import { CloudflareGoldenImageLive } from "./CloudflareGoldenImage.ts"
import { CloudflareBackendDoctorLive } from "./CloudflareBackendDoctor.ts"
import { CloudflareTeamLive } from "./CloudflareTeam.ts"
import { CloudflareProvisionerLive } from "./CloudflareProvisioner.ts"
import { CfWorkerLive } from "./CfWorker.ts"

/**
 * Aggregate Layer that wires up every Backend service tag with the Cloudflare
 * implementation. Selected by `cli.ts` when `afk.config.json` has
 * `backend: "cloudflare"`.
 *
 * `CloudflareGoldenImageLive` depends on ImageRegistry + ConfigService + Docker,
 * so it is provided on top of the leaves (for ImageRegistry) and re-exported for
 * the `golden` commands. `CloudflareComputeLive` consumes GoldenImageStore (the
 * Run-start gate) + RunHistory, so the golden+leaves bundle is provided into it.
 *
 * `CfWorkerLive` (the launcher-Worker HTTP client) is consumed by Compute and
 * several leaves (LogStore, RunHistory, SecretStore, Team), so it is provided
 * into the leaves *and* re-exported upward for Compute via `provideMerge`.
 */
const Leaves = Layer.mergeAll(
  CloudflareImageRegistryLive,
  CloudflareSecretStoreLive,
  CloudflareLogStoreLive,
  CloudflareSessionArtifactStoreLive,
  CloudflareRunHistoryLive,
  CloudflareBackendDoctorLive,
  CloudflareTeamLive,
  CloudflareProvisionerLive,
).pipe(Layer.provideMerge(CfWorkerLive))

const Golden = CloudflareGoldenImageLive.pipe(Layer.provideMerge(Leaves))

export const CloudflareBackendLive = CloudflareComputeLive.pipe(
  Layer.provideMerge(Golden),
)
