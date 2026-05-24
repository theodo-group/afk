import { Layer } from "effect"
import { LocalComputeLive } from "./LocalCompute.ts"
import { LocalImageRegistryLive } from "./LocalImageRegistry.ts"
import { LocalSecretStoreLive } from "./LocalSecretStore.ts"
import { LocalLogStoreLive } from "./LocalLogStore.ts"
import { LocalRunHistoryLive } from "./LocalRunHistory.ts"
import { LocalGoldenImageLive } from "./LocalGoldenImage.ts"
import { LocalBackendDoctorLive } from "./LocalBackendDoctor.ts"
import { LocalTeamLive } from "./LocalTeam.ts"
import { LocalProvisionerLive } from "./LocalProvisioner.ts"

/**
 * Aggregate Layer wiring every Backend service tag to the Local implementation.
 * Selected by `cli.ts` when `afk.config.json` has `backend: "local"` or when
 * `--local` is passed on any command.
 *
 * Like the AWS aggregate, `LocalComputeLive` consumes `GoldenImageStore` (the
 * Run-start gate — it boots from the latest local Golden Image) and `RunHistory`
 * (to record starts), so the leaves are provided into it and re-exported for the
 * `golden`/`secrets` commands.
 */
const Leaves = Layer.mergeAll(
  LocalImageRegistryLive,
  LocalSecretStoreLive,
  LocalLogStoreLive,
  LocalRunHistoryLive,
  LocalGoldenImageLive,
  LocalBackendDoctorLive,
  LocalTeamLive,
  LocalProvisionerLive,
)

export const LocalBackendLive = LocalComputeLive.pipe(
  Layer.provideMerge(Leaves),
)
