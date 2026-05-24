import { Effect, Layer } from "effect"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { Docker } from "../../adapters/Docker.ts"
import { Subprocess } from "../../infra/Subprocess.ts"
import { ConfigService } from "../../services/ConfigService.ts"
import { ImageRegistry } from "../../services/backend/ImageRegistry.ts"
import {
  GoldenImageStore,
  type GoldenImage,
} from "../../services/backend/GoldenImage.ts"
import {
  GOLDEN_REPO,
  goldenUri,
  planCloudflareGolden,
} from "./CloudflareGoldenPlan.ts"
import { CLOUDFLARE_BOOTSTRAP } from "./cloudflareBootstrap.ts"
import { patchWranglerToml } from "../../infra/CfToml.ts"
import { CloudflareError, ConfigError, UserError } from "../../infra/Errors.ts"
import { parseWranglerJsonArray } from "./wranglerJson.ts"

/** Extract the registry tag from a full golden image id (or accept a bare tag). */
const tagOf = (id: string): string =>
  id.includes(":") ? id.slice(id.lastIndexOf(":") + 1) : id

/**
 * Cloudflare implementation of the Golden Image store. The artifact is a
 * `docker:28-dind-rootless` container image with the configured
 * `cloudflare.cachedImages` skopeo-baked into `/var/afk/cache/*.tar`, pushed to
 * the CF managed registry as `registry.cloudflare.com/<accountId>/afk-golden:<version>`.
 *
 * `build` patches the freshly-built image URI into `worker/afk/wrangler.toml`'s
 * `[[containers]]` block so `afk provision` / `wrangler deploy` boots from it —
 * the patch is part of "build a golden a Run can boot from", so it lives here
 * rather than leaking back into the `afk golden build` command.
 */
export const CloudflareGoldenImageLive = Layer.effect(
  GoldenImageStore,
  Effect.gen(function* () {
    const docker = yield* Docker
    const sub = yield* Subprocess
    const cfg = yield* ConfigService
    const registry = yield* ImageRegistry

    const requireAccountId = Effect.gen(function* () {
      const { config } = yield* cfg.load
      const id = config.cloudflare?.accountId
      if (!id) {
        return yield* Effect.fail(
          new UserError({
            message: "cloudflare.accountId is not set in afk.config.json.",
            hint: "Run `afk init --provider cloudflare` first.",
          }),
        )
      }
      return id
    })

    // List the golden tags via `wrangler containers images list --json`, which
    // performs the CF managed-registry auth handshake itself. The registry
    // exposes only repo/tag here — builtAt / cachedImages aren't surfaced, so
    // version === tag and metadata is empty. Newest-first ≈ descending tag sort.
    const list = Effect.gen(function* () {
      const accountId = yield* requireAccountId
      const result = yield* sub
        .run("wrangler", ["containers", "images", "list", "--json"])
        .pipe(
          Effect.mapError(
            (e) =>
              new CloudflareError({
                operation: "registry:list",
                message: `wrangler containers images list failed: ${e.stderr || String(e)}`,
              }),
          ),
        )
      const repos = yield* parseWranglerJsonArray<{
        name: string
        tags?: ReadonlyArray<string>
      }>(result.stdout, "registry:list")
      const repo = repos.find((r) => r.name === GOLDEN_REPO)
      const tags = [...(repo?.tags ?? [])].sort((a, b) => b.localeCompare(a))
      return tags.map(
        (tag): GoldenImage => ({
          id: goldenUri(accountId, tag),
          displayName: tag,
          version: tag,
          builtAt: "",
          cachedImages: [],
          ready: true,
        }),
      )
    })

    const findLatest = list.pipe(Effect.map((images) => images[0] ?? null))

    // `wrangler containers images delete <repo>:<tag>` removes one tag from the
    // CF managed registry (it performs the registry auth itself).
    const remove = (id: string) =>
      sub
        .runInteractive("wrangler", [
          "containers",
          "images",
          "delete",
          `${GOLDEN_REPO}:${tagOf(id)}`,
        ])
        .pipe(
          Effect.mapError(
            (e) =>
              new CloudflareError({
                operation: "registry:deleteTag",
                message: `wrangler containers images delete failed: ${e.stderr || String(e)}`,
              }),
          ),
        )

    const build = Effect.gen(function* () {
      const { config, projectRoot } = yield* cfg.load
      const accountId = yield* requireAccountId

      const plan = planCloudflareGolden({
        config,
        accountId,
        bootstrap: CLOUDFLARE_BOOTSTRAP,
        builtAt: new Date().toISOString(),
      })
      const { cachedImages, version, builtAt, imageUri } = plan

      // Materialize build context under .afk/cf-golden-build/ (gitignored via
      // the `.afk/` entry that `afk init` adds for us).
      const buildDir = resolve(projectRoot, ".afk", "cf-golden-build")
      yield* Effect.try({
        try: () => {
          mkdirSync(buildDir, { recursive: true })
          writeFileSync(resolve(buildDir, "Dockerfile"), plan.dockerfile)
          writeFileSync(
            resolve(buildDir, "bootstrap.sh"),
            CLOUDFLARE_BOOTSTRAP,
            {
              mode: 0o755,
            },
          )
        },
        catch: (cause) =>
          new ConfigError({
            path: buildDir,
            message: `cannot write golden build context: ${String(cause)}`,
          }),
      })

      // Ensure CF registry auth (docker login against registry.cloudflare.com/
      // <accountId>). Repo name is the path-prefix after the host.
      yield* registry.ensureRepoAndAuth(`${accountId}/${GOLDEN_REPO}`)

      yield* docker.build({
        contextDir: buildDir,
        dockerfile: resolve(buildDir, "Dockerfile"),
        tag: imageUri,
        platform: "linux/amd64",
        inlineCache: true,
      })

      yield* registry.push(imageUri)

      // Patch the freshly-built image into worker/afk/wrangler.toml's
      // [[containers]] block so `afk provision` / `wrangler deploy` boots from it.
      const tomlPath = resolve(projectRoot, "worker", "afk", "wrangler.toml")
      const patched = existsSync(tomlPath)
      if (patched) {
        yield* Effect.try({
          try: () => patchWranglerToml(tomlPath, { imageUri }),
          catch: (cause) =>
            new ConfigError({
              path: tomlPath,
              message: `cannot patch wrangler.toml: ${String(cause)}`,
            }),
        })
      }

      return {
        id: imageUri,
        displayName: version,
        version,
        builtAt,
        cachedImages,
        note: patched
          ? `patched image into ${tomlPath}`
          : `no worker/afk/wrangler.toml yet (run \`afk init\`)`,
      }
    })

    return GoldenImageStore.of({ build, list, findLatest, remove })
  }),
)
