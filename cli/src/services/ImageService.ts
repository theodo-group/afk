import { Context, Effect, Layer, Schedule, Duration } from "effect"
import { Ec2 } from "../adapters/aws/Ec2.ts"
import { Ssm } from "../adapters/aws/Ssm.ts"
import { ConfigService } from "./ConfigService.ts"
import { AwsError, UserError, ConfigError } from "../infra/Errors.ts"
import {
  AFK_SECURITY_GROUP,
  AFK_VM_INSTANCE_PROFILE,
  AFK_VPC_NAME,
  DEFAULT_REGION,
  TAG_GOLDEN,
  TAG_GOLDEN_BUILT_AT,
  TAG_GOLDEN_CACHED_IMAGES,
  TAG_GOLDEN_VERSION,
  TAG_MANAGED,
} from "../constants.ts"

export interface GoldenImage {
  readonly imageId: string
  readonly name: string
  readonly creationDate: string
  readonly state: string
  readonly cachedImages: ReadonlyArray<string>
  readonly version: string
  readonly builtAt: string
}

export interface BuildOutput {
  readonly imageId: string
  readonly name: string
  readonly cachedImages: ReadonlyArray<string>
  readonly builtAt: string
}

export class ImageService extends Context.Tag("ImageService")<
  ImageService,
  {
    readonly build: Effect.Effect<BuildOutput, AwsError | UserError | ConfigError>
    readonly listGolden: (region: string) => Effect.Effect<ReadonlyArray<GoldenImage>, AwsError>
    readonly findLatestGolden: (
      region: string,
    ) => Effect.Effect<GoldenImage | null, AwsError>
    readonly remove: (
      region: string,
      imageId: string,
    ) => Effect.Effect<void, AwsError>
  }
>() {}

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

const versionHash = (cachedImages: ReadonlyArray<string>): string => {
  const sorted = [...cachedImages].sort()
  // Stable short version: count + first chars of joined names.
  const joined = sorted.join(",")
  let h = 0
  for (let i = 0; i < joined.length; i++) {
    h = ((h << 5) - h + joined.charCodeAt(i)) | 0
  }
  return `v1-${sorted.length}-${(h >>> 0).toString(16).padStart(8, "0")}`
}

const tagToImage = (img: {
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
    imageId: img.imageId,
    name: img.name ?? "",
    creationDate: img.creationDate ?? "",
    state: img.state,
    cachedImages: cached,
    version: t[TAG_GOLDEN_VERSION] ?? "",
    builtAt: t[TAG_GOLDEN_BUILT_AT] ?? img.creationDate ?? "",
  }
}

export const ImageServiceLive = Layer.effect(
  ImageService,
  Effect.gen(function* () {
    const ec2 = yield* Ec2
    const ssm = yield* Ssm
    const cfg = yield* ConfigService

    const listGolden = (region: string) =>
      ec2
        .describeImages({
          region,
          owners: ["self"],
          tagFilters: [{ key: TAG_GOLDEN, values: ["true"] }],
        })
        .pipe(
          Effect.map((images) =>
            images
              .map(tagToImage)
              .filter((g): g is GoldenImage => g !== null)
              .sort((a, b) => (a.builtAt < b.builtAt ? 1 : -1)),
          ),
        )

    const findLatestGolden = (region: string) =>
      listGolden(region).pipe(
        Effect.map((images) =>
          images.find((i) => i.state === "available") ?? null,
        ),
      )

    return ImageService.of({
      listGolden,
      findLatestGolden,

      remove: (region, imageId) => ec2.deregisterImage(region, imageId),

      build: Effect.gen(function* () {
        const { config } = yield* cfg.load
        const region = config.aws?.region ?? DEFAULT_REGION
        const cachedImages = config.golden?.cachedImages ?? []

        const vpcId = yield* ec2.findVpcIdByName(region, AFK_VPC_NAME)
        const subnetIds = yield* ec2.findSubnetIdsByVpcId(region, vpcId)
        if (subnetIds.length === 0) {
          return yield* Effect.fail(
            new UserError({
              message: `No subnets found in VPC '${AFK_VPC_NAME}'.`,
              hint: "Apply the AFK Terraform first.",
            }),
          )
        }
        const sgId = yield* ec2.findSecurityGroupIdByName(region, vpcId, AFK_SECURITY_GROUP)
        const baseAmi = yield* ec2.findLatestAmazonLinuxAmi(region)
        const version = versionHash(cachedImages)
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
          securityGroupIds: [sgId],
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

        // Wait for builder running, then poll until SSM picks it up.
        yield* ec2.waitForInstance(region, builderId, "running").pipe(
          Effect.tapError(() => cleanup),
        )

        // Run the install/pull script via SSM.
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

        // Snapshot. CreateImage on a running instance reboots it by default
        // to ensure a clean snapshot — fine for the throwaway builder.
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

        // Builder no longer needed.
        yield* cleanup

        return {
          imageId,
          name: amiName,
          cachedImages,
          builtAt,
        }
      }),
    })
  }),
)
