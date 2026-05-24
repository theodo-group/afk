import { Effect, Layer, Schedule, Duration } from "effect"
import { Ec2 } from "../../adapters/aws/Ec2.ts"
import { resolveAfkNetworkPlacement } from "./AwsNetworkPlacement.ts"
import { planAwsGolden } from "./AwsGoldenPlan.ts"
import { Ssm } from "../../adapters/aws/Ssm.ts"
import { ConfigService } from "../../services/ConfigService.ts"
import {
  GoldenImageStore,
  type GoldenImage,
} from "../../services/backend/GoldenImage.ts"
import { AwsError } from "../../infra/Errors.ts"
import {
  AFK_VM_INSTANCE_PROFILE,
  DEFAULT_REGION,
  TAG_GOLDEN,
  TAG_GOLDEN_BUILT_AT,
  TAG_GOLDEN_CACHED_IMAGES,
  TAG_GOLDEN_VERSION,
} from "../../constants.ts"

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
      resolveRegion.pipe(
        Effect.flatMap((region) => ec2.deregisterImage(region, id)),
      )

    const build = Effect.gen(function* () {
      const { config } = yield* cfg.load
      const region = config.aws?.region ?? DEFAULT_REGION

      // Builder VM uses minimal user-data so the SSM agent comes up; the real
      // work is sent via SSM SendCommand once the instance is ready (gives us
      // synchronous failure reporting). The pure plan (version, names, tags,
      // pre-pull script) is assembled in the core with the clock injected.
      const plan = planAwsGolden({ config, builtAt: new Date().toISOString() })

      const { subnetIds, securityGroupId } = yield* resolveAfkNetworkPlacement(
        ec2,
        region,
      )
      const baseAmi = yield* ec2.findLatestAmazonLinuxAmi(region)

      const { instanceId: builderId } = yield* ec2.runInstance({
        region,
        imageId: baseAmi,
        instanceType: "t3.medium",
        subnetId: subnetIds[0]!,
        securityGroupIds: [securityGroupId],
        iamInstanceProfileName: AFK_VM_INSTANCE_PROFILE,
        userData: plan.builderUserData,
        spot: false,
        // The builder VM is not a Run; it is terminated once the AMI is baked.
        shutdownBehavior: "terminate",
        tags: [...plan.builderTags],
      })

      const cleanup = ec2
        .terminateInstances(region, [builderId])
        .pipe(Effect.catchAll(() => Effect.void))

      yield* ec2
        .waitForInstance(region, builderId, "running")
        .pipe(Effect.tapError(() => cleanup))

      const cmd = yield* ssm
        .sendShellCommand({
          region,
          instanceId: builderId,
          commands: [plan.script],
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
          name: plan.amiName,
          description: plan.description,
          tags: [...plan.imageTags],
        })
        .pipe(Effect.tapError(() => cleanup))

      yield* ec2
        .waitForImage(region, imageId)
        .pipe(Effect.tapError(() => cleanup))
      yield* cleanup

      return {
        id: imageId,
        displayName: plan.amiName,
        version: plan.version,
        builtAt: plan.builtAt,
        cachedImages: plan.cachedImages,
      }
    })

    return GoldenImageStore.of({ build, list, findLatest, remove })
  }),
)
