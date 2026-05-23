import { Layer } from "effect"
import { CloudflareComputeLive } from "./CloudflareCompute.ts"
import { CloudflareImageRegistryLive } from "./CloudflareImageRegistry.ts"
import { CloudflareSecretStoreLive } from "./CloudflareSecretStore.ts"
import { CloudflareLogStoreLive } from "./CloudflareLogStore.ts"
import { CloudflareRunHistoryLive } from "./CloudflareRunHistory.ts"
import { CloudflareGoldenBuilderLive } from "../../services/CloudflareGoldenBuilder.ts"

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

// CloudflareGoldenBuilderLive depends on ImageRegistry + ConfigService + Docker.
// We provide it on top of Leaves so it sees the CF ImageRegistry, and re-export
// it in the aggregate output so the `golden` command-layer dispatch can consume
// it. Parallel to where AWS's `ImageServiceLive` sits — except CF's lives
// inside the backend bundle (it has no cross-backend reuse).
const GoldenBuilder = CloudflareGoldenBuilderLive.pipe(
  Layer.provideMerge(Leaves),
)

export const CloudflareBackendLive = CloudflareComputeLive.pipe(
  Layer.provideMerge(GoldenBuilder),
)
