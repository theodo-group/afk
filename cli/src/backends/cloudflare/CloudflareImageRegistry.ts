import { Effect, Layer } from "effect"
import { ImageRegistry } from "../../services/backend/ImageRegistry.ts"
import { ConfigService } from "../../services/ConfigService.ts"
import { Subprocess } from "../../infra/Subprocess.ts"
import { CloudflareError } from "../../infra/Errors.ts"

const CF_REGISTRY_HOST = "registry.cloudflare.com"

/**
 * Cloudflare implementation of ImageRegistry. Backed by CF's managed Container
 * registry at `registry.cloudflare.com/<account-id>/<repo>:<tag>`.
 *
 * Pushes go through `wrangler containers push`, which performs the registry
 * credential exchange against the CF managed registry internally. (The raw
 * CLOUDFLARE_API_TOKEN is NOT a valid `docker login` password for
 * registry.cloudflare.com — it always 401s — so we delegate to wrangler
 * rather than driving `docker push` ourselves.)
 *
 * Existence checks and tag listing call the Distribution v2 HTTP API. The
 * exact auth flow CF uses for that registry is not 100% pinned down at the
 * time of writing — see the TODO markers. When in doubt we return "false" /
 * "[]" so BuildService always rebuilds + pushes (correct, just less efficient).
 */
export const CloudflareImageRegistryLive = Layer.effect(
  ImageRegistry,
  Effect.gen(function* () {
    const sub = yield* Subprocess
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
                  "CLOUDFLARE_API_TOKEN env var is not set. Create a token with 'Workers Containers' + 'Cloudflare Images' edit scopes and export it before running `afk run`.",
              }),
            )
          }
          // No explicit docker login: `wrangler containers push` (used in
          // `push` below) performs the registry credential exchange itself.
          // A raw-token `docker login` to registry.cloudflare.com 401s.
        }),

      // `wrangler containers push <tag>` resolves registry credentials from
      // CLOUDFLARE_API_TOKEN and pushes the already-built local image.
      push: (imageUri) =>
        sub
          .runInteractive("wrangler", ["containers", "push", imageUri])
          .pipe(
            Effect.mapError(
              (e) =>
                new CloudflareError({
                  operation: "registry:push",
                  message: `wrangler containers push failed: ${e.stderr || String(e)}`,
                }),
            ),
          ),
    })
  }),
)
