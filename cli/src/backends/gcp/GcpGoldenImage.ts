import { Duration, Effect, Layer, Schedule } from "effect"
import { Gce } from "../../adapters/gcp/Gce.ts"
import { Auth } from "../../adapters/gcp/Auth.ts"
import { Subprocess } from "../../infra/Subprocess.ts"
import { Output } from "../../infra/Output.ts"
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

// Debian 12 ("bookworm") public image family. Trade-off vs cos-stable:
//   - COS is the natural pick for a host-Docker shape (boots faster, smaller
//     attack surface), but COS has a read-only root fs and no package manager,
//     so we can't install gcloud or other CLIs on it.
//   - The startup-script uses `gcloud` for AR auth, Secret Manager fetches,
//     GCS uploads, and self-delete — the GCP analogue of how AWS's user-data
//     uses `aws` (which is preinstalled on Amazon Linux). There is no public
//     GCE image that ships gcloud preinstalled, so we install it ourselves at
//     golden-build time on a writable base. Debian 12 is the smallest such
//     base with first-class apt support for the Docker + Google Cloud SDK
//     repos used in `buildScript`.
const BUILDER_BASE_IMAGE =
  "projects/debian-cloud/global/images/family/debian-12"
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
    const out = yield* Output

    const phase = (msg: string) =>
      out.mode === "json" ? Effect.void : out.print(msg)

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
        // On-demand: a preemption mid-build would waste the snapshot work.
        spot: false,
        maxRunDurationSeconds: BUILDER_MAX_RUN_SECONDS,
        labels: [{ key: "afk-purpose", value: "image-builder" }],
      })

      const cleanup = gce
        .deleteInstance(project, zone, plan.builderName)
        .pipe(Effect.catchAll(() => Effect.void))

      // Poll the build-done marker over IAP SSH (the startup-script touches it
      // once the pre-pull finishes). Each pass depends on the previous probe.
      // The startup-script can sit silent for several minutes while pre-pulling
      // sidecar images, so emit a heartbeat per poll so the user knows we're
      // still alive (build progress isn't streamable over IAP SSH from a
      // builder we don't own a console on).
      const pollStartedAt = Date.now()
      yield* phase(
        `• builder VM up (${plan.builderName}) — waiting for image pre-pull (poll every 10s, ≤10min)…`,
      )
      const probe = sub
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
        )
      const waitForBuild = probe.pipe(
        Effect.tapError(() =>
          phase(
            `  …still building (elapsed ${Math.round((Date.now() - pollStartedAt) / 1000)}s)`,
          ),
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
      yield* phase(
        `• image pre-pull complete (took ${Math.round((Date.now() - pollStartedAt) / 1000)}s)`,
      )

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
