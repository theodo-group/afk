import { Layer } from "effect"
import { CloudflareComputeLive } from "./CloudflareCompute.ts"
import { CloudflareImageRegistryLive } from "./CloudflareImageRegistry.ts"
import { CloudflareSecretStoreLive } from "./CloudflareSecretStore.ts"
import { CloudflareLogStoreLive } from "./CloudflareLogStore.ts"
import { CloudflareRunHistoryLive } from "./CloudflareRunHistory.ts"

/**
 * Aggregate Layer that wires up every Backend service tag with the Cloudflare
 * implementation. Selected by `cli.ts` when `afk.config.json` has
 * `backend: "cloudflare"`.
 *
 * The same `provideMerge(Leaves)` pattern as the AWS aggregate is used to
 * satisfy CloudflareComputeLive's intra-backend RunHistory dep while still
 * exposing every leaf in the aggregate's output for the cross-cutting
 * facades (SecretService, HistoryService, BuildService).
 */
const Leaves = Layer.mergeAll(
  CloudflareImageRegistryLive,
  CloudflareSecretStoreLive,
  CloudflareLogStoreLive,
  CloudflareRunHistoryLive,
)

export const CloudflareBackendLive = CloudflareComputeLive.pipe(
  Layer.provideMerge(Leaves),
)
