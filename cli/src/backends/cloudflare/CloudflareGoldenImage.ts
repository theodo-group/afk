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
import { goldenVersionHash } from "../../services/GoldenImageVersion.ts"
import { patchWranglerToml } from "../../infra/CfToml.ts"
import { CloudflareError, UserError } from "../../infra/Errors.ts"

const CF_REGISTRY_HOST = "registry.cloudflare.com"
const GOLDEN_REPO = "afk-golden"

/** Sanitize an image ref into a filename-safe token for the OCI archive name. */
const safeName = (imageRef: string): string =>
  imageRef.replace(/[^a-zA-Z0-9._-]+/g, "_")

/** Extract the registry tag from a full golden image id (or accept a bare tag). */
const tagOf = (id: string): string =>
  id.includes(":") ? id.slice(id.lastIndexOf(":") + 1) : id

const ENTRYPOINT_SCRIPT = `#!/bin/sh
# afk golden entrypoint — loads skopeo-baked OCI archives into rootless dockerd
# before handing off to the container's own command. The CF Container runtime
# invokes this as PID 1.
set -eu

CACHE_DIR="\${AFK_GOLDEN_CACHE_DIR:-/var/afk/cache}"
DOCKERD_LOG="\${AFK_DOCKERD_LOG:-/var/log/dockerd.log}"

# Start the Docker engine. On CF Containers (Firecracker microVM) the VM is
# the isolation boundary, so we run dockerd as ROOT with:
#   --exec-opt native.cgroupdriver=cgroupfs  (no systemd in the container)
#   --bridge=none --iptables=false           (CF blocks NAT/netfilter setup)
# and run workloads with --network host. (Rootless + slirp4netns is not viable
# here: /dev/net/tun is root-only and netns/netlink ops are denied to non-root.)
# This combination is verified working on Cloudflare Containers.
echo "afk-golden: starting dockerd"
dockerd --bridge=none --iptables=false --exec-opt native.cgroupdriver=cgroupfs \\
  >"\$DOCKERD_LOG" 2>&1 &
i=0
while [ \$i -lt 60 ]; do docker info >/dev/null 2>&1 && break; i=\$((i+1)); sleep 1; done
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

echo "afk-golden: bootstrap complete"

# --- Run the per-Run workload, if one was injected -------------------------
# The RunDO passes the wrapped agent image + command + (optional) compose +
# a short-lived registry pull credential + the workload env (base64) via the
# Container's environment. This is the CF analog of the AWS user_data: golden
# provides the engine, the workload runs inside it. Absent these (e.g. an
# \`afk attach --host\` debug boot), we fall back to the container's own CMD.
if [ -n "\${AFK_IMAGE:-}" ]; then
  LOG=/var/afk/workload.log
  : > "\$LOG"

  ENV_FILE=/var/afk/run.env
  if [ -n "\${AFK_RUN_ENV_B64:-}" ]; then
    echo "\$AFK_RUN_ENV_B64" | base64 -d > "\$ENV_FILE"
  else
    : > "\$ENV_FILE"
  fi
  chmod 600 "\$ENV_FILE"

  # Authenticate to the CF managed registry with the minted pull credential.
  if [ -n "\${AFK_REGISTRY_PASSWORD:-}" ]; then
    echo "\$AFK_REGISTRY_PASSWORD" | timeout 60 docker login registry.cloudflare.com \\
      -u "\${AFK_REGISTRY_USER:-v1}" --password-stdin >>"\$LOG" 2>&1
  fi

  echo "afk-golden: pulling \$AFK_IMAGE" >>"\$LOG"
  timeout 600 docker pull "\$AFK_IMAGE" >>"\$LOG" 2>&1

  TIMEOUT="\${AFK_TIMEOUT_SECONDS:-14400}"
  set +e
  if [ -n "\${AFK_COMPOSE_YML:-}" ]; then
    mkdir -p /etc/afk
    printf '%s' "\$AFK_COMPOSE_YML" > /etc/afk/compose.yml
    # Export the vars the compose file interpolates: \${AFK_COMMAND} and
    # \${AFK_ENV_FILE} (the env_file: path), plus source the env for the rest.
    export AFK_COMMAND
    export AFK_ENV_FILE="\$ENV_FILE"
    set -a; . "\$ENV_FILE"; set +a
    timeout "\$TIMEOUT" docker compose -f /etc/afk/compose.yml \\
      up --exit-code-from "\${AFK_MAIN_SERVICE:-agent}" --abort-on-container-exit \\
      >>"\$LOG" 2>&1
    RUN_EXIT=\$?
    docker compose -f /etc/afk/compose.yml down -v --remove-orphans >/dev/null 2>&1 || true
  else
    # --network host: child containers share the CF container's network (no
    # bridge/NAT is available — see dockerd flags above).
    timeout "\$TIMEOUT" docker run --rm --network host \\
      --env-file "\$ENV_FILE" "\$AFK_IMAGE" sh -c "\$AFK_COMMAND" \\
      >>"\$LOG" 2>&1
    RUN_EXIT=\$?
  fi
  cat "\$LOG" 2>/dev/null || true
  echo "afk-golden: workload exited \$RUN_EXIT"

  # Ship logs + exit code back to the launcher Worker (the CF analog of the AWS
  # awslogs driver). The Worker stores them so \`afk logs\` and \`afk ls\` work.
  if [ -n "\${AFK_COMPLETE_URL:-}" ]; then
    LOG_B64=\$(tail -c 131072 "\$LOG" 2>/dev/null | base64 | tr -d '\\n')
    wget -qO- --header="Content-Type: application/json" \\
      --post-data="{\\"exitCode\\":\$RUN_EXIT,\\"logB64\\":\\"\$LOG_B64\\"}" \\
      "\$AFK_COMPLETE_URL" >/dev/null 2>&1 || true
  fi
  exit "\$RUN_EXIT"
fi

echo "afk-golden: no AFK_IMAGE; exec \$@"
exec "\$@"
`

const dockerfileFor = (cachedImages: ReadonlyArray<string>): string => {
  const lines: string[] = []
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
  lines.push(``)
  lines.push(`FROM docker:28-dind-rootless`)
  lines.push(`USER root`)
  lines.push(`RUN mkdir -p /var/afk/cache /var/log && chown -R rootless:rootless /var/afk /var/log`)
  if (cachedImages.length > 0) {
    lines.push(`COPY --from=skopeo-bake /out/ /var/afk/cache/`)
  }
  lines.push(`COPY bootstrap.sh /var/afk/bootstrap.sh`)
  lines.push(`RUN chmod +x /var/afk/bootstrap.sh`)
  // Run as ROOT (no `USER rootless`). On CF's Firecracker microVM the VM is the
  // isolation boundary; root is required to run dockerd with a working engine
  // (open /dev/net/tun, manage cgroups, attach containers to the host network).
  // Rootless (uid 1000) cannot — /dev/net/tun is root-only and netns ops are
  // denied. Verified on Cloudflare Containers.
  lines.push(`ENTRYPOINT ["/var/afk/bootstrap.sh"]`)
  // Default CMD just keeps the container alive — the per-Run wrapper
  // (FROM afk-golden:*) overrides this with the agent's actual command.
  lines.push(`CMD ["sh", "-c", "tail -f /dev/null"]`)
  lines.push(``)
  return lines.join("\n")
}

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

    const goldenUri = (accountId: string, tag: string): string =>
      `${CF_REGISTRY_HOST}/${accountId}/${GOLDEN_REPO}:${tag}`

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
      // wrangler prints human banners (telemetry notice, …) to stdout before the
      // JSON payload, so slice out the top-level array rather than parsing raw.
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
      const cachedImages = config.cloudflare?.cachedImages ?? []
      const accountId = yield* requireAccountId

      const version = goldenVersionHash(cachedImages)
      const builtAt = new Date().toISOString()
      const imageUri = goldenUri(accountId, version)

      // Materialize build context under .afk/cf-golden-build/ (gitignored via
      // the `.afk/` entry that `afk init` adds for us).
      const buildDir = resolve(projectRoot, ".afk", "cf-golden-build")
      mkdirSync(buildDir, { recursive: true })
      writeFileSync(resolve(buildDir, "Dockerfile"), dockerfileFor(cachedImages))
      writeFileSync(resolve(buildDir, "bootstrap.sh"), ENTRYPOINT_SCRIPT, {
        mode: 0o755,
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
      if (patched) patchWranglerToml(tomlPath, { imageUri })

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
