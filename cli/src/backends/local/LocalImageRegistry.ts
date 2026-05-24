import { Effect, Layer } from "effect"
import { ImageRegistry } from "../../services/backend/ImageRegistry.ts"
import { Subprocess } from "../../infra/Subprocess.ts"

/**
 * Local implementation of ImageRegistry. There is no remote registry: the
 * developer's own Docker daemon *is* the registry. `BuildService` builds the
 * wrapped agent image to the tag `local/<repo>:<tag>` (registryUri = "local"),
 * and `push` is a no-op — the image is already in the daemon. `LocalCompute`
 * later crosses it into the Run's inner rootless dind via `docker save`/`load`
 * (the Local analogue of the cloud pull), so nothing leaves the machine.
 */
const LOCAL_REGISTRY = "local"

export const LocalImageRegistryLive = Layer.effect(
  ImageRegistry,
  Effect.gen(function* () {
    const sub = yield* Subprocess

    return ImageRegistry.of({
      registryUri: Effect.succeed(LOCAL_REGISTRY),

      imageExists: (repoName, tag) =>
        sub
          .run("docker", ["image", "inspect", `${LOCAL_REGISTRY}/${repoName}:${tag}`])
          .pipe(
            Effect.map(() => true),
            Effect.catchAll(() => Effect.succeed(false)),
          ),

      // No registry to query for cache-from candidates; BuildKit's local layer
      // cache already covers same-daemon rebuilds.
      listLatestTagsByPrefix: () => Effect.succeed([]),

      ensureRepoAndAuth: () => Effect.void,

      push: () => Effect.void,
    })
  }),
)
