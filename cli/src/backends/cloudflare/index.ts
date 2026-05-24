import { Layer } from "effect"
import { CloudflareComputeLive } from "./CloudflareCompute.ts"
import { CloudflareImageRegistryLive } from "./CloudflareImageRegistry.ts"
import { CloudflareSecretStoreLive } from "./CloudflareSecretStore.ts"
import { CloudflareLogStoreLive } from "./CloudflareLogStore.ts"
import { CloudflareRunHistoryLive } from "./CloudflareRunHistory.ts"
import { CloudflareGoldenImageLive } from "./CloudflareGoldenImage.ts"
import { CloudflareBackendDoctorLive } from "./CloudflareBackendDoctor.ts"

/**
 * Aggregate Layer that wires up every Backend service tag with the Cloudflare
 * implementation. Selected by `cli.ts` when `afk.config.json` has
 * `backend: "cloudflare"`.
 *
 * `CloudflareGoldenImageLive` depends on ImageRegistry + ConfigService + Docker,
 * so it is provided on top of the leaves (for ImageRegistry) and re-exported for
 * the `golden` commands. `CloudflareComputeLive` consumes GoldenImageStore (the
 * Run-start gate) + RunHistory, so the golden+leaves bundle is provided into it.
 */
const Leaves = Layer.mergeAll(
  CloudflareImageRegistryLive,
  CloudflareSecretStoreLive,
  CloudflareLogStoreLive,
  CloudflareRunHistoryLive,
  CloudflareBackendDoctorLive,
)

const Golden = CloudflareGoldenImageLive.pipe(Layer.provideMerge(Leaves))

export const CloudflareBackendLive = CloudflareComputeLive.pipe(
  Layer.provideMerge(Golden),
)
