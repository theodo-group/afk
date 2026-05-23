import { Effect, Layer } from "effect"
import { ImageRegistry } from "../../services/backend/ImageRegistry.ts"
import { Ecr } from "../../adapters/aws/Ecr.ts"
import { Docker } from "../../adapters/Docker.ts"
import { ConfigService } from "../../services/ConfigService.ts"
import { DEFAULT_REGION, ECR_LIFECYCLE_DAYS } from "../../constants.ts"
import { AwsError } from "../../infra/Errors.ts"

/**
 * AWS implementation of ImageRegistry. Backed by ECR, scoped to the region
 * declared in `afk.config.json`'s `aws.region` block.
 */
export const AwsImageRegistryLive = Layer.effect(
  ImageRegistry,
  Effect.gen(function* () {
    const ecr = yield* Ecr
    const docker = yield* Docker
    const cfg = yield* ConfigService

    const region = cfg.load.pipe(
      Effect.map((r) => r.config.aws?.region ?? DEFAULT_REGION),
      Effect.mapError(
        (e) =>
          new AwsError({
            operation: "config:resolveRegion",
            message: e.message ?? String(e),
          }),
      ),
    )

    return ImageRegistry.of({
      registryUri: Effect.gen(function* () {
        const r = yield* region
        return yield* ecr.registryUri(r)
      }),

      imageExists: (repoName, tag) =>
        Effect.gen(function* () {
          const r = yield* region
          return yield* ecr.imageExists(r, repoName, tag)
        }),

      listLatestTagsByPrefix: (repoName, tagPrefix, limit) =>
        Effect.gen(function* () {
          const r = yield* region
          return yield* ecr.listLatestTagsByPrefix(r, repoName, tagPrefix, limit)
        }),

      ensureRepoAndAuth: (repoName) =>
        Effect.gen(function* () {
          const r = yield* region
          yield* ecr.ensureRepository(r, repoName, ECR_LIFECYCLE_DAYS)
          const registry = yield* ecr.registryUri(r)
          const password = yield* ecr.getLoginPassword(r)
          yield* docker.login(registry, "AWS", password)
        }),

      push: (imageUri) => docker.push(imageUri),
    })
  }),
)
