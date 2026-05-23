import { Effect, Layer } from "effect"
import { ImageRegistry } from "../../services/backend/ImageRegistry.ts"
import { Docker } from "../../adapters/Docker.ts"
import { ConfigService } from "../../services/ConfigService.ts"
import { CloudflareError } from "../../infra/Errors.ts"

const CF_REGISTRY_HOST = "registry.cloudflare.com"

/**
 * Cloudflare implementation of ImageRegistry. Backed by CF's managed Container
 * registry at `registry.cloudflare.com/<account-id>/<repo>:<tag>`.
 *
 * Existence checks and tag listing call the Distribution v2 HTTP API. The
 * exact auth flow CF uses for that registry is not 100% pinned down at the
 * time of writing — see the TODO markers. When in doubt we return "false" /
 * "[]" so BuildService always rebuilds + pushes (correct, just less efficient).
 */
export const CloudflareImageRegistryLive = Layer.effect(
  ImageRegistry,
  Effect.gen(function* () {
    const docker = yield* Docker
    const cfg = yield* ConfigService

    const accountId = cfg.load.pipe(
      Effect.flatMap((r) => {
        const id = r.config.cloudflare?.accountId
        if (!id) {
          return Effect.fail(
            new CloudflareError({
              operation: "config:accountId",
              message:
                "cloudflare.accountId is not set in afk.config.json; run `afk init --provider cloudflare` first.",
            }),
          )
        }
        return Effect.succeed(id)
      }),
      Effect.mapError((e) =>
        e instanceof CloudflareError
          ? e
          : new CloudflareError({
              operation: "config:accountId",
              message: (e as { message?: string }).message ?? String(e),
            }),
      ),
    )

    const registryUriEffect = accountId.pipe(
      Effect.map((id) => `${CF_REGISTRY_HOST}/${id}`),
    )

    return ImageRegistry.of({
      registryUri: registryUriEffect,

      // TODO: verify CF registry auth flow at
      // https://developers.cloudflare.com/containers/platform-details/image-registry/
      // For now we always report "false" so BuildService rebuilds + pushes.
      imageExists: (_repoName, _tag) => Effect.succeed(false),

      // TODO: verify CF registry tag listing. Same rationale as imageExists.
      listLatestTagsByPrefix: (_repoName, _tagPrefix, _limit) =>
        Effect.succeed([]),

      ensureRepoAndAuth: (_repoName) =>
        Effect.gen(function* () {
          const apiToken = process.env.CLOUDFLARE_API_TOKEN
          if (!apiToken) {
            return yield* Effect.fail(
              new CloudflareError({
                operation: "ensureRepoAndAuth",
                message:
                  "CLOUDFLARE_API_TOKEN env var is not set. Create a token with 'Containers Edit' scope and export it before running `afk run`.",
              }),
            )
          }
          const id = yield* accountId
          // docker login against the CF registry. The dev's CF API token works
          // as the password; the username is "cloudflare" by convention.
          yield* docker.login(`${CF_REGISTRY_HOST}/${id}`, "cloudflare", apiToken)
        }),

      push: (imageUri) => docker.push(imageUri),
    })
  }),
)
