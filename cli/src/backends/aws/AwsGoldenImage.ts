import { Effect, Layer, Schedule, Duration } from "effect"
import { Ec2 } from "../../adapters/aws/Ec2.ts"
import { resolveAfkNetworkPlacement } from "./AwsNetworkPlacement.ts"
import { Ssm } from "../../adapters/aws/Ssm.ts"
import { ConfigService } from "../../services/ConfigService.ts"
import {
  GoldenImageStore,
  type GoldenImage,
} from "../../services/backend/GoldenImage.ts"
import { goldenVersionHash } from "../../services/GoldenImageVersion.ts"
import { AwsError } from "../../infra/Errors.ts"
import {
  AFK_VM_INSTANCE_PROFILE,
  DEFAULT_REGION,
  TAG_GOLDEN,
  TAG_GOLDEN_BUILT_AT,
  TAG_GOLDEN_CACHED_IMAGES,
  TAG_GOLDEN_VERSION,
  TAG_MANAGED,
} from "../../constants.ts"

const buildScript = (cachedImages: ReadonlyArray<string>): string => {
  const pulls = cachedImages
    .map((img) => `docker pull ${img} || echo "warning: failed to pre-pull ${img}"`)
    .join("\n")
  return [
    "#!/bin/bash",
    "set -euo pipefail",
    "echo 'afk-image-build: installing Docker'",
    "dnf install -y docker",
    "systemctl enable --now docker",
    "echo 'afk-image-build: installing docker compose plugin'",
    "mkdir -p /usr/libexec/docker/cli-plugins",
    "DOCKER_COMPOSE_VERSION=v2.32.4",
    "curl -fsSL -o /usr/libexec/docker/cli-plugins/docker-compose \\",
    "  https://github.com/docker/compose/releases/download/$DOCKER_COMPOSE_VERSION/docker-compose-linux-x86_64",
    "chmod +x /usr/libexec/docker/cli-plugins/docker-compose",
    "echo 'afk-image-build: pre-pulling cached images'",
    pulls || "echo '(no cached images requested)'",
    "echo 'afk-image-build: cleaning docker apt cache to reduce AMI size'",
    "docker image prune -f >/dev/null || true",
    "echo 'afk-image-build: done'",
  ].join("\n")
}

const tagToGolden = (img: {
  imageId: string
  name?: string
  creationDate?: string
  state: string
  tags: ReadonlyArray<{ key: string; value: string }>
}): GoldenImage | null => {
  const t = Object.fromEntries(img.tags.map((x) => [x.key, x.value]))
  if (t[TAG_GOLDEN] !== "true") return null
  const cached = t[TAG_GOLDEN_CACHED_IMAGES]
    ? t[TAG_GOLDEN_CACHED_IMAGES].split(",").filter(Boolean)
    : []
  return {
    id: img.imageId,
    displayName: img.name ?? img.imageId,
    version: t[TAG_GOLDEN_VERSION] ?? "",
    builtAt: t[TAG_GOLDEN_BUILT_AT] ?? img.creationDate ?? "",
    cachedImages: cached,
    ready: img.state === "available",
    backendDetails: { state: img.state },
  }
}

/**
 * AWS implementation of the Golden Image store. The artifact is an AMI built by
 * booting a throwaway builder VM, pre-pulling the configured images via SSM, and
 * snapshotting it. `id` is the AMI id; `findLatest` is what `AwsCompute` boots a
 * Run from.
 */
export const AwsGoldenImageLive = Layer.effect(
  GoldenImageStore,
  Effect.gen(function* () {
    const ec2 = yield* Ec2
    const ssm = yield* Ssm
    const cfg = yield* ConfigService

    const resolveRegion = cfg.load.pipe(
      Effect.map((r) => r.config.aws?.region ?? DEFAULT_REGION),
    )

    const list = Effect.gen(function* () {
      const region = yield* resolveRegion
      const images = yield* ec2.describeImages({
        region,
        owners: ["self"],
        tagFilters: [{ key: TAG_GOLDEN, values: ["true"] }],
      })
      return images
        .map(tagToGolden)
        .filter((g): g is GoldenImage => g !== null)
        .sort((a, b) => (a.builtAt < b.builtAt ? 1 : -1))
    })

    const findLatest = list.pipe(
      Effect.map((images) => images.find((i) => i.ready) ?? null),
    )

    const remove = (id: string) =>
      resolveRegion.pipe(Effect.flatMap((region) => ec2.deregisterImage(region, id)))

    const build = Effect.gen(function* () {
      const { config } = yield* cfg.load
      const region = config.aws?.region ?? DEFAULT_REGION
      // Prefer `aws.cachedImages` (canonical); fall back to legacy `golden.cachedImages`.
      const cachedImages = config.aws?.cachedImages ?? config.golden?.cachedImages ?? []

      const { subnetIds, securityGroupId } = yield* resolveAfkNetworkPlacement(
        ec2,
        region,
      )
      const baseAmi = yield* ec2.findLatestAmazonLinuxAmi(region)
      const version = goldenVersionHash(cachedImages)
      const builtAt = new Date().toISOString()
      const amiName = `afk-golden-${version}-${builtAt.replace(/[:.]/g, "-")}`

      // Builder VM: minimal user-data so the SSM agent comes up; the real
      // work is sent via SSM SendCommand once the instance is ready (gives
      // us synchronous failure reporting).
      const builderUserData = [
        "#!/bin/bash",
        "set -euo pipefail",
        "echo afk-builder ready",
      ].join("\n")

      const { instanceId: builderId } = yield* ec2.runInstance({
        region,
        imageId: baseAmi,
        instanceType: "t3.medium",
        subnetId: subnetIds[0]!,
        securityGroupIds: [securityGroupId],
        iamInstanceProfileName: AFK_VM_INSTANCE_PROFILE,
        userData: builderUserData,
        spot: false,
        tags: [
          { key: TAG_MANAGED, value: "true" },
          { key: "Name", value: `afk-image-builder-${version}` },
          { key: "afk:purpose", value: "image-builder" },
        ],
      })

      const cleanup = ec2.terminateInstances(region, [builderId]).pipe(
        Effect.catchAll(() => Effect.void),
      )

      yield* ec2.waitForInstance(region, builderId, "running").pipe(
        Effect.tapError(() => cleanup),
      )

      const script = buildScript(cachedImages)
      const cmd = yield* ssm
        .sendShellCommand({
          region,
          instanceId: builderId,
          commands: [script],
          timeoutSeconds: 1800,
        })
        .pipe(
          // SSM agent may not be online yet immediately after running state.
          // Retry with a fixed 5s spacing for up to ~3 minutes.
          Effect.retry(
            Schedule.intersect(
              Schedule.spaced(Duration.seconds(5)),
              Schedule.recurs(36),
            ),
          ),
          Effect.tapError(() => cleanup),
        )

      const result = yield* ssm
        .waitForCommand({
          region,
          commandId: cmd.commandId,
          instanceId: builderId,
          pollIntervalMs: 3000,
          maxWaitMs: 30 * 60 * 1000,
        })
        .pipe(Effect.tapError(() => cleanup))

      if (result.status !== "Success") {
        yield* cleanup
        return yield* Effect.fail(
          new AwsError({
            operation: "ssm:RunCommand",
            message: `image-build script failed (status ${result.status}): ${result.stderr || result.stdout}`,
          }),
        )
      }

      // CreateImage on a running instance reboots it by default to ensure a
      // clean snapshot — fine for the throwaway builder.
      const { imageId } = yield* ec2
        .createImage({
          region,
          instanceId: builderId,
          name: amiName,
          description: `AFK golden image (${cachedImages.length} cached images)`,
          tags: [
            { key: TAG_GOLDEN, value: "true" },
            { key: TAG_GOLDEN_VERSION, value: version },
            { key: TAG_GOLDEN_BUILT_AT, value: builtAt },
            { key: TAG_GOLDEN_CACHED_IMAGES, value: cachedImages.join(",") },
            { key: "Name", value: amiName },
          ],
        })
        .pipe(Effect.tapError(() => cleanup))

      yield* ec2.waitForImage(region, imageId).pipe(Effect.tapError(() => cleanup))
      yield* cleanup

      return {
        id: imageId,
        displayName: amiName,
        version,
        builtAt,
        cachedImages,
      }
    })

    return GoldenImageStore.of({ build, list, findLatest, remove })
  }),
)
