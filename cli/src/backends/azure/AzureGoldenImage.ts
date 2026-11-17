import { Effect, Layer } from "effect"
import { AzVm, type AzureImage } from "../../adapters/azure/AzVm.ts"
import { AzAuth } from "../../adapters/azure/AzAuth.ts"
import { Output } from "../../infra/Output.ts"
import { ConfigService } from "../../services/ConfigService.ts"
import {
  GoldenImageStore,
  type GoldenImage,
} from "../../services/backend/GoldenImage.ts"
import {
  AZURE_TAG_BUILT_AT,
  AZURE_TAG_CACHED_IMAGES,
  AZURE_TAG_GOLDEN,
  AZURE_TAG_GOLDEN_VERSION,
} from "../../constants.ts"
import { makeResolveAzureCoords } from "./azureCoords.ts"
import { throwawayAdminPublicKey } from "./AzureSshKey.ts"
import { DEPROVISION_SCRIPT, planAzureGolden } from "./AzureGoldenPlan.ts"

// Ubuntu 22.04 LTS, Gen2: apt-installable Docker and Azure CLI, and the
// cloud-init + walinuxagent pair a generalized managed image needs.
const BUILDER_BASE_IMAGE =
  "Canonical:0001-com-ubuntu-server-jammy:22_04-lts-gen2:latest"
const BUILDER_VM_SIZE = "Standard_D2s_v5"

const parseCachedImages = (raw: string | undefined): ReadonlyArray<string> => {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) && parsed.every((x) => typeof x === "string")
      ? (parsed as ReadonlyArray<string>)
      : []
  } catch {
    return []
  }
}

const imageToGolden = (img: AzureImage): GoldenImage | null =>
  img.tags[AZURE_TAG_GOLDEN] !== "true"
    ? null
    : {
        id: img.name,
        displayName: img.name,
        version: img.tags[AZURE_TAG_GOLDEN_VERSION] ?? "",
        builtAt: img.tags[AZURE_TAG_BUILT_AT] ?? "",
        cachedImages: parseCachedImages(img.tags[AZURE_TAG_CACHED_IMAGES]),
        ready: img.provisioningState === "Succeeded",
        backendDetails: {
          provisioningState: img.provisioningState,
          resourceId: img.id,
        },
      }

/**
 * Azure implementation of the Golden Image store. The artifact is a
 * generalized managed image in the afk resource group, captured from a
 * throwaway builder VM: the build script runs over the VM agent
 * (`run-command`), so the builder needs no network path from the developer and
 * its progress is a single blocking call rather than a poll. `findLatest` is
 * what `AzureCompute` boots a Run from.
 */
export const AzureGoldenImageLive = Layer.effect(
  GoldenImageStore,
  Effect.gen(function* () {
    const vms = yield* AzVm
    const auth = yield* AzAuth
    const cfg = yield* ConfigService
    const out = yield* Output
    const coords = makeResolveAzureCoords(cfg, auth)

    const phase = (msg: string) =>
      out.mode === "json" ? Effect.void : out.print(msg)

    const list = Effect.gen(function* () {
      const { resourceGroup } = yield* coords
      const images = yield* vms.listImages(resourceGroup)
      return images
        .map(imageToGolden)
        .filter((g): g is GoldenImage => g !== null)
        .sort((a, b) => (a.builtAt < b.builtAt ? 1 : -1))
    })

    const findLatest = list.pipe(
      Effect.map((images) => images.find((i) => i.ready) ?? null),
    )

    const remove = (id: string) =>
      coords.pipe(
        Effect.flatMap(({ resourceGroup }) =>
          vms.deleteImage(resourceGroup, id),
        ),
      )

    const build = Effect.gen(function* () {
      const { config } = yield* cfg.load
      const { resourceGroup, location, names } = yield* coords
      const plan = planAzureGolden({
        config,
        builtAt: new Date().toISOString(),
      })

      yield* phase(`• creating builder VM ${plan.builderName}…`)
      yield* vms.createVm({
        resourceGroup,
        location,
        name: plan.builderName,
        size: BUILDER_VM_SIZE,
        image: BUILDER_BASE_IMAGE,
        subnetId: names.subnetId,
        identityId: names.identityId,
        adminSshPublicKey: throwawayAdminPublicKey(),
        // On-demand: an eviction mid-build would waste the pre-pull.
        spot: false,
        tags: { "afk-purpose": "image-builder" },
      })

      const cleanup = vms
        .deleteVm(resourceGroup, plan.builderName, { wait: true })
        .pipe(Effect.catchAll(() => Effect.void))

      const captured = Effect.gen(function* () {
        const startedAt = Date.now()
        yield* phase(
          "• installing Docker + Azure CLI and pre-pulling images (one blocking call, typically 5-10 min)…",
        )
        const log = yield* vms.runShell(
          resourceGroup,
          plan.builderName,
          plan.builderScript,
        )
        yield* Effect.logDebug(log)
        yield* phase(
          `• pre-pull complete (took ${Math.round((Date.now() - startedAt) / 1000)}s) — capturing image…`,
        )
        yield* vms.runShell(resourceGroup, plan.builderName, DEPROVISION_SCRIPT)
        yield* vms.deallocateVm(resourceGroup, plan.builderName)
        yield* vms.generalizeVm(resourceGroup, plan.builderName)
        yield* vms.createImage({
          resourceGroup,
          name: plan.imageName,
          sourceVm: plan.builderName,
          tags: plan.imageTags,
        })
      })
      yield* captured.pipe(Effect.ensuring(cleanup))

      return {
        id: plan.imageName,
        displayName: plan.imageName,
        version: plan.version,
        builtAt: plan.builtAt,
        cachedImages: plan.cachedImages,
      }
    })

    return GoldenImageStore.of({ build, list, findLatest, remove })
  }),
)
