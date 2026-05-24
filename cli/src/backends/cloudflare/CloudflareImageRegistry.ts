import { Effect, Layer } from "effect"
import { ImageRegistry } from "../../services/backend/ImageRegistry.ts"
import { ConfigService } from "../../services/ConfigService.ts"
import { Subprocess } from "../../infra/Subprocess.ts"
import { CloudflareError } from "../../infra/Errors.ts"
import { parseWranglerJsonArray } from "./wranglerJson.ts"

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
 * Existence checks and tag listing reuse the same proven path as the golden
 * image store: `wrangler containers images list --json`, which performs the
 * CF managed-registry auth handshake itself.
 */

/** Drop a leading `<accountId>/` prefix; the registry lists repos bare. */
const bareRepo = (repoName: string): string =>
  repoName.includes("/") ? repoName.slice(repoName.lastIndexOf("/") + 1) : repoName

export const CloudflareImageRegistryLive = Layer.effect(
  ImageRegistry,
  Effect.gen(function* () {
    const sub = yield* Subprocess
    const cfg = yield* ConfigService

    // List the tags for one repo via `wrangler containers images list --json`.
    // wrangler prints human banners (telemetry notice, …) to stdout before the
    // JSON payload, so slice out the top-level array rather than parsing raw.
    // The registry lists repos by their bare name (no `<accountId>/` prefix).
    const tagsForRepo = (repoName: string) =>
      sub
        .run("wrangler", ["containers", "images", "list", "--json"])
        .pipe(
          Effect.mapError(
            (e) =>
              new CloudflareError({
                operation: "registry:list",
                message: `wrangler containers images list failed: ${e.stderr || String(e)}`,
              }),
          ),
          Effect.flatMap((result) =>
            parseWranglerJsonArray<{
              name: string
              tags?: ReadonlyArray<string>
            }>(result.stdout, "registry:list"),
          ),
          Effect.map((repos) => {
            const target = bareRepo(repoName)
            const repo = repos.find((r) => r.name === target)
            return [...(repo?.tags ?? [])]
          }),
        )

    const accountId = cfg.load.pipe(
      Effect.mapError(
        (e) =>
          new CloudflareError({
            operation: "config:accountId",
            message: e.message,
          }),
      ),
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
    )

    const registryUriEffect = accountId.pipe(
      Effect.map((id) => `${CF_REGISTRY_HOST}/${id}`),
    )

    return ImageRegistry.of({
      registryUri: registryUriEffect,

      imageExists: (repoName, tag) =>
        tagsForRepo(repoName).pipe(Effect.map((tags) => tags.includes(tag))),

      // Newest tags matching `<repo>:<tagPrefix>*`. The registry surfaces no
      // build order, so newest-first ≈ descending tag sort (mirrors golden).
      listLatestTagsByPrefix: (repoName, tagPrefix, limit) =>
        tagsForRepo(repoName).pipe(
          Effect.map((tags) =>
            tags
              .filter((t) => t.startsWith(tagPrefix))
              .sort((a, b) => b.localeCompare(a))
              .slice(0, limit),
          ),
        ),

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
