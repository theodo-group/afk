import { Context, Effect, Layer } from "effect"
import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { Docker } from "../adapters/Docker.ts"
import { Subprocess } from "../infra/Subprocess.ts"
import { ConfigService } from "./ConfigService.ts"
import { ImageRegistry } from "./backend/ImageRegistry.ts"
import {
  AwsError,
  CloudflareError,
  ConfigError,
  DockerError,
  UserError,
} from "../infra/Errors.ts"

const CF_REGISTRY_HOST = "registry.cloudflare.com"
const GOLDEN_REPO = "afk-golden"

export interface CloudflareGoldenImage {
  readonly tag: string
  readonly imageUri: string
  readonly version: string
  readonly builtAt: string
  readonly cachedImages: ReadonlyArray<string>
}

export interface CloudflareGoldenBuildOutput {
  readonly tag: string
  readonly imageUri: string
  readonly version: string
  readonly builtAt: string
  readonly cachedImages: ReadonlyArray<string>
}

/**
 * Cloudflare equivalent of the AWS Golden AMI builder. Produces a container
 * image based on `docker:28-dind-rootless` with the configured
 * `cloudflare.cachedImages` skopeo-baked into `/var/afk/cache/*.tar`, plus a
 * boot-time entrypoint that loads them into the rootless Docker daemon's data
 * dir before exec-ing the container's own command.
 *
 * Tagged as `registry.cloudflare.com/<accountId>/afk-golden:<versionHash>` and
 * pushed to Cloudflare's managed Container registry.
 */
export class CloudflareGoldenBuilder extends Context.Tag(
  "CloudflareGoldenBuilder",
)<
  CloudflareGoldenBuilder,
  {
    readonly build: Effect.Effect<
      CloudflareGoldenBuildOutput,
      CloudflareError | UserError | ConfigError | DockerError | AwsError
    >
    readonly list: Effect.Effect<
      ReadonlyArray<CloudflareGoldenImage>,
      CloudflareError | UserError | ConfigError
    >
    readonly remove: (
      tag: string,
    ) => Effect.Effect<void, CloudflareError | UserError | ConfigError>
    readonly findLatest: Effect.Effect<
      CloudflareGoldenImage | null,
      CloudflareError | UserError | ConfigError
    >
  }
>() {}

/** Stable short version hash from a sorted list of cached image refs. */
const versionHash = (cachedImages: ReadonlyArray<string>): string => {
  const sorted = [...cachedImages].sort()
  const joined = sorted.join(",")
  let h = 0
  for (let i = 0; i < joined.length; i++) {
    h = ((h << 5) - h + joined.charCodeAt(i)) | 0
  }
  return `v1-${sorted.length}-${(h >>> 0).toString(16).padStart(8, "0")}`
}

/** Sanitize an image ref into a filename-safe token for the OCI archive name. */
const safeName = (imageRef: string): string =>
  imageRef.replace(/[^a-zA-Z0-9._-]+/g, "_")

const ENTRYPOINT_SCRIPT = `#!/bin/sh
# afk golden entrypoint — loads skopeo-baked OCI archives into rootless dockerd
# before handing off to the container's own command. The CF Container runtime
# invokes this as PID 1.
set -eu

CACHE_DIR="\${AFK_GOLDEN_CACHE_DIR:-/var/afk/cache}"
DOCKERD_LOG="\${AFK_DOCKERD_LOG:-/var/log/dockerd.log}"

# Start the rootless docker daemon in the background. The base image
# (docker:28-dind-rootless) ships dockerd-rootless.sh on PATH.
echo "afk-golden: starting rootless dockerd"
dockerd-rootless.sh >"\$DOCKERD_LOG" 2>&1 &

# Wait for the socket to come up. dockerd-rootless puts it at
# /run/user/<uid>/docker.sock by default.
for i in $(seq 1 60); do
  if docker info >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
if ! docker info >/dev/null 2>&1; then
  echo "afk-golden: dockerd did not become ready in 60s" >&2
  tail -n 200 "\$DOCKERD_LOG" >&2 || true
  exit 1
fi

# Hydrate the daemon with our baked OCI archives.
if [ -d "\$CACHE_DIR" ]; then
  for archive in "\$CACHE_DIR"/*.tar; do
    [ -e "\$archive" ] || continue
    echo "afk-golden: loading \$archive"
    docker load -i "\$archive" || echo "afk-golden: warn: failed to load \$archive" >&2
  done
fi

echo "afk-golden: bootstrap complete; exec \$@"
exec "\$@"
`

const dockerfileFor = (cachedImages: ReadonlyArray<string>): string => {
  const lines: string[] = []
  // Stage 1: pull skopeo (alpine) and pre-fetch each image as an OCI archive.
  lines.push(`# syntax=docker/dockerfile:1.7`)
  lines.push(`FROM alpine:3.20 AS skopeo-bake`)
  lines.push(`RUN apk add --no-cache skopeo ca-certificates`)
  lines.push(`WORKDIR /out`)
  for (const img of cachedImages) {
    const name = safeName(img)
    // Each skopeo copy is its own RUN so layer caching is per-image.
    lines.push(
      `RUN skopeo copy --override-os linux docker://${img} oci-archive:/out/${name}.tar`,
    )
  }
  // Stage 2: final image — rootless dind + baked archives + entrypoint.
  lines.push(``)
  lines.push(`FROM docker:28-dind-rootless`)
  lines.push(`USER root`)
  lines.push(`RUN mkdir -p /var/afk/cache /var/log && chown -R rootless:rootless /var/afk /var/log`)
  if (cachedImages.length > 0) {
    lines.push(`COPY --from=skopeo-bake /out/ /var/afk/cache/`)
  }
  lines.push(`COPY bootstrap.sh /var/afk/bootstrap.sh`)
  lines.push(`RUN chmod +x /var/afk/bootstrap.sh`)
  lines.push(`USER rootless`)
  lines.push(`ENTRYPOINT ["/var/afk/bootstrap.sh"]`)
  // Default CMD just keeps the container alive — the per-Run wrapper
  // (FROM afk-golden:*) overrides this with the agent's actual command.
  lines.push(`CMD ["sh", "-c", "tail -f /dev/null"]`)
  lines.push(``)
  return lines.join("\n")
}

export const CloudflareGoldenBuilderLive = Layer.effect(
  CloudflareGoldenBuilder,
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

    const goldenUri = (accountId: string, tag: string): string =>
      `${CF_REGISTRY_HOST}/${accountId}/${GOLDEN_REPO}:${tag}`

    // List the golden tags via `wrangler containers images list --json`, which
    // performs the CF managed-registry auth handshake itself. Output shape:
    //   [{ "name": "afk-golden", "tags": ["v1-0-…", …] }, …]
    // The registry exposes only repo/tag here — builtAt / cachedImages aren't
    // surfaced, so we fill those from the tag (version === tag) and leave the
    // metadata empty. Newest-first is approximated by descending tag sort.
    const listImages: Effect.Effect<
      ReadonlyArray<CloudflareGoldenImage>,
      CloudflareError | UserError | ConfigError
    > = Effect.gen(function* () {
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
      // wrangler prints human banners (telemetry notice, "agent skills
      // available", …) to stdout before the JSON payload, so slice out the
      // top-level array rather than parsing raw stdout.
      const repos = yield* Effect.try({
        try: () => {
          const start = result.stdout.indexOf("[")
          const end = result.stdout.lastIndexOf("]")
          if (start === -1 || end === -1 || end < start) {
            throw new Error(`no JSON array in output: ${result.stdout.slice(0, 200)}`)
          }
          return JSON.parse(result.stdout.slice(start, end + 1)) as ReadonlyArray<{
            name: string
            tags?: ReadonlyArray<string>
          }>
        },
        catch: (cause) =>
          new CloudflareError({
            operation: "registry:list",
            message: `could not parse wrangler images JSON: ${String(cause)}`,
          }),
      })
      const repo = repos.find((r) => r.name === GOLDEN_REPO)
      const tags = [...(repo?.tags ?? [])].sort((a, b) => b.localeCompare(a))
      return tags.map((tag) => ({
        tag,
        version: tag,
        imageUri: goldenUri(accountId, tag),
        builtAt: "",
        cachedImages: [],
      }))
    })

    return CloudflareGoldenBuilder.of({
      build: Effect.gen(function* () {
        const { config, projectRoot } = yield* cfg.load
        const cachedImages = config.cloudflare?.cachedImages ?? []
        const accountId = yield* requireAccountId

        const version = versionHash(cachedImages)
        const builtAt = new Date().toISOString()
        const imageUri = goldenUri(accountId, version)

        // Materialize build context under .afk/cf-golden-build/ (gitignored
        // via the `.afk/` entry that `afk init` adds for us).
        const buildDir = resolve(projectRoot, ".afk", "cf-golden-build")
        mkdirSync(buildDir, { recursive: true })
        writeFileSync(
          resolve(buildDir, "Dockerfile"),
          dockerfileFor(cachedImages),
        )
        writeFileSync(resolve(buildDir, "bootstrap.sh"), ENTRYPOINT_SCRIPT, {
          mode: 0o755,
        })

        // Ensure CF registry auth (docker login against
        // registry.cloudflare.com/<accountId>). Repo name is the path-prefix
        // after the host — `<accountId>/<repo>`.
        yield* registry.ensureRepoAndAuth(`${accountId}/${GOLDEN_REPO}`)

        yield* docker.build({
          contextDir: buildDir,
          dockerfile: resolve(buildDir, "Dockerfile"),
          tag: imageUri,
          platform: "linux/amd64",
          inlineCache: true,
        })

        yield* registry.push(imageUri)

        return {
          tag: version,
          imageUri,
          version,
          builtAt,
          cachedImages,
        }
      }),

      list: listImages,

      // `wrangler containers images delete <repo>:<tag>` removes one tag from
      // the CF managed registry (it performs the registry auth itself).
      remove: (tag) =>
        sub
          .runInteractive("wrangler", [
            "containers",
            "images",
            "delete",
            `${GOLDEN_REPO}:${tag}`,
          ])
          .pipe(
            Effect.mapError(
              (e) =>
                new CloudflareError({
                  operation: "registry:deleteTag",
                  message: `wrangler containers images delete failed: ${e.stderr || String(e)}`,
                }),
            ),
          ),

      // Newest golden = head of the descending-sorted tag list; null when none.
      findLatest: listImages.pipe(
        Effect.map((images) => images[0] ?? null),
      ),
    })
  }),
)
