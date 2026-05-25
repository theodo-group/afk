import { Effect, Layer } from "effect"
import { ImageRegistry } from "../../services/backend/ImageRegistry.ts"
import { ArtifactRegistry } from "../../adapters/gcp/ArtifactRegistry.ts"
import { Auth } from "../../adapters/gcp/Auth.ts"
import { Docker } from "../../adapters/Docker.ts"
import { ConfigService } from "../../services/ConfigService.ts"
import { GCP_ARTIFACT_REPO, GCP_DEFAULT_REGION } from "../../constants.ts"
import { GcpError } from "../../infra/Errors.ts"

/**
 * GCP implementation of ImageRegistry. Backed by an Artifact Registry Docker
 * repository, scoped to `gcp.region` / `gcp.projectId` in `afk.config.json`.
 * `repoName` from BuildService is the per-build image name *inside* the single
 * `afk` repository.
 */
export const GcpImageRegistryLive = Layer.effect(
  ImageRegistry,
  Effect.gen(function* () {
    const ar = yield* ArtifactRegistry
    const auth = yield* Auth
    const docker = yield* Docker
    const cfg = yield* ConfigService

    const coords = Effect.gen(function* () {
      const { config } = yield* cfg.load
      const region = config.gcp?.region ?? GCP_DEFAULT_REGION
      const project = config.gcp?.projectId ?? (yield* auth.activeProject)
      return { region, project }
    }).pipe(
      Effect.mapError((e) =>
        e._tag === "GcpError"
          ? e
          : new GcpError({
              operation: "config:resolveGcpCoords",
              message: e.message ?? String(e),
            }),
      ),
    )

    return ImageRegistry.of({
      registryUri: Effect.gen(function* () {
        const { region, project } = yield* coords
        return yield* ar.registryUri(project, region, GCP_ARTIFACT_REPO)
      }),

      imageExists: (repoName, tag) =>
        Effect.gen(function* () {
          const { region, project } = yield* coords
          return yield* ar.imageExists(
            project,
            region,
            GCP_ARTIFACT_REPO,
            repoName,
            tag,
          )
        }),

      listLatestTagsByPrefix: (repoName, tagPrefix, limit) =>
        Effect.gen(function* () {
          const { region, project } = yield* coords
          return yield* ar.listLatestTagsByPrefix(
            project,
            region,
            GCP_ARTIFACT_REPO,
            repoName,
            tagPrefix,
            limit,
          )
        }),

      ensureRepoAndAuth: (_repoName) =>
        Effect.gen(function* () {
          const { region, project } = yield* coords
          yield* ar.ensureRepoAndAuth(project, region, GCP_ARTIFACT_REPO)
        }),

      push: (imageUri) => docker.push(imageUri),
    })
  }),
)
