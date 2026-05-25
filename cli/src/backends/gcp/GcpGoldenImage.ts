import { Duration, Effect, Layer, Schedule } from "effect"
import { Gce } from "../../adapters/gcp/Gce.ts"
import { Auth } from "../../adapters/gcp/Auth.ts"
import { Subprocess } from "../../infra/Subprocess.ts"
import { resolveGcpNetworkPlacement } from "./GcpNetworkPlacement.ts"
import { planGcpGolden } from "./GcpGoldenPlan.ts"
import { ConfigService } from "../../services/ConfigService.ts"
import {
  GoldenImageStore,
  type GoldenImage,
} from "../../services/backend/GoldenImage.ts"
import { GcpError } from "../../infra/Errors.ts"
import {
  GCP_DEFAULT_REGION,
  GCP_DEFAULT_ZONE,
  GCP_GOLDEN_IMAGE_FAMILY,
  GCP_LABEL_GOLDEN,
  GCP_LABEL_GOLDEN_VERSION,
} from "../../constants.ts"

// Public Container-Optimized OS image family: ships Docker, boots fast, and is
// the natural base for the dind-less host-Docker shape the GCP Run uses.
const BUILDER_BASE_IMAGE = "projects/cos-cloud/global/images/family/cos-stable"
const BUILDER_MACHINE_TYPE = "e2-standard-2"
// Builder backstop: deleted explicitly after snapshot; this caps a leak.
const BUILDER_MAX_RUN_SECONDS = 3600

// The pre-pulled image list is stashed in the image's free-text description as
// JSON (GCE labels can't hold image refs), the analogue of the AWS
// `afk:cached-images` tag. Tolerate a missing/garbled description.
const parseCachedImages = (description?: string): ReadonlyArray<string> => {
  if (!description) return []
  try {
    const parsed = JSON.parse(description) as unknown
    return Array.isArray(parsed) && parsed.every((x) => typeof x === "string")
      ? (parsed as ReadonlyArray<string>)
      : []
  } catch {
    return []
  }
}

const imageToGolden = (img: {
  name: string
  family?: string
  status: string
  creationTimestamp?: string
  labels: ReadonlyArray<{ key: string; value: string }>
  description?: string
}): GoldenImage | null => {
  const m = Object.fromEntries(img.labels.map((l) => [l.key, l.value]))
  if (m[GCP_LABEL_GOLDEN] !== "true") return null
  return {
    id: img.name,
    displayName: img.name,
    version: m[GCP_LABEL_GOLDEN_VERSION] ?? "",
    builtAt: img.creationTimestamp ?? "",
    cachedImages: parseCachedImages(img.description),
    ready: img.status === "READY",
    backendDetails: { status: img.status },
  }
}

/**
 * GCP implementation of the Golden Image store. The artifact is a GCE custom
 * image in the `afk-golden` family, built by booting a throwaway COS builder VM
 * whose startup-script pre-pulls the configured images, then snapshotting its
 * boot disk with `gcloud compute images create`. `id` is the image name;
 * `findLatest` is what `GcpCompute` boots a Run from (via `family/afk-golden`).
 */
export const GcpGoldenImageLive = Layer.effect(
  GoldenImageStore,
  Effect.gen(function* () {
    const gce = yield* Gce
    const auth = yield* Auth
    const sub = yield* Subprocess
    const cfg = yield* ConfigService

    const coords = Effect.gen(function* () {
      const { config } = yield* cfg.load
      const project = config.gcp?.projectId ?? (yield* auth.activeProject)
      const region = config.gcp?.region ?? GCP_DEFAULT_REGION
      const zone = config.gcp?.zone ?? GCP_DEFAULT_ZONE
      return { project, region, zone }
    })

    const list = Effect.gen(function* () {
      const { project } = yield* coords
      const images = yield* gce.listImages(project, GCP_GOLDEN_IMAGE_FAMILY)
      return images
        .map(imageToGolden)
        .filter((g): g is GoldenImage => g !== null)
        .sort((a, b) => (a.builtAt < b.builtAt ? 1 : -1))
    })

    const findLatest = list.pipe(
      Effect.map((images) => images.find((i) => i.ready) ?? null),
    )

    const remove = (id: string) =>
      coords.pipe(Effect.flatMap(({ project }) => gce.deleteImage(project, id)))

    const build = Effect.gen(function* () {
      const { config } = yield* cfg.load
      const { project, region, zone } = yield* coords
      const plan = planGcpGolden({ config, builtAt: new Date().toISOString() })
      const { subnet, serviceAccount } = resolveGcpNetworkPlacement(
        project,
        region,
      )

      yield* gce.createInstance({
        project,
        zone,
        name: plan.builderName,
        machineType: BUILDER_MACHINE_TYPE,
        image: BUILDER_BASE_IMAGE,
        serviceAccount,
        subnet,
        startupScript: plan.builderStartupScript,
        maxRunDurationSeconds: BUILDER_MAX_RUN_SECONDS,
        labels: [{ key: "afk-purpose", value: "image-builder" }],
      })

      const cleanup = gce
        .deleteInstance(project, zone, plan.builderName)
        .pipe(Effect.catchAll(() => Effect.void))

      // Poll the build-done marker over IAP SSH (the startup-script touches it
      // once the pre-pull finishes). Each pass depends on the previous probe.
      const waitForBuild = sub
        .run("gcloud", [
          "compute",
          "ssh",
          plan.builderName,
          `--project=${project}`,
          `--zone=${zone}`,
          "--tunnel-through-iap",
          "--command",
          "test -f /var/afk-build-done",
        ])
        .pipe(
          Effect.mapError(
            (e) =>
              new GcpError({
                operation: "golden:waitForBuild",
                message: e.stderr,
              }),
          ),
          Effect.retry(
            Schedule.intersect(
              Schedule.spaced(Duration.seconds(10)),
              Schedule.recurs(60),
            ),
          ),
          Effect.tapError(() => cleanup),
        )
      yield* waitForBuild

      // Stop the builder before snapshotting its boot disk. GCE rejects
      // `images create` while the disk is attached to a RUNNING instance, and
      // stopping fsyncs the filesystem (so the snapshot captures every layer
      // the pre-pull wrote, not just the dirty page cache contents).
      yield* gce
        .stopInstance(project, zone, plan.builderName)
        .pipe(Effect.tapError(() => cleanup))

      yield* gce
        .createImage({
          project,
          name: plan.imageName,
          family: plan.family,
          sourceDisk: plan.builderName,
          sourceDiskZone: zone,
          labels: plan.imageLabels,
          // Persist the pre-pulled list so `afk golden ls` can show it back
          // (read by parseCachedImages above).
          description: JSON.stringify(plan.cachedImages),
        })
        .pipe(Effect.tapError(() => cleanup))

      yield* cleanup

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
