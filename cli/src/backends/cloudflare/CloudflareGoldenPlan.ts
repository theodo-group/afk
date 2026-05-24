import type { AfkConfig } from "../../schema/Config.ts"
import { goldenVersionHash } from "../../services/GoldenImageVersion.ts"
import {
  cacheCopyLine,
  ensureAfkDirs,
  installBootstrap,
  skopeoBakeStage,
} from "../../services/DindGolden.ts"

// ---------------------------------------------------------------------------
// Functional core for the Cloudflare golden-image build: pure, no I/O, no clock.
// The shell (`CloudflareGoldenImage`) gathers the effectful inputs (config,
// accountId, the bootstrap script baked into the image) and the non-deterministic
// seed (`builtAt`), calls this to assemble the version, image URI, and the
// Dockerfile, then performs the build/push/wrangler-patch effects the plan gates.
// Testable with plain assertions, no Layer.
// ---------------------------------------------------------------------------

export const CF_REGISTRY_HOST = "registry.cloudflare.com"
export const GOLDEN_REPO = "afk-golden"

/** `registry.cloudflare.com/<accountId>/afk-golden:<tag>`. */
export const goldenUri = (accountId: string, tag: string): string =>
  `${CF_REGISTRY_HOST}/${accountId}/${GOLDEN_REPO}:${tag}`

/**
 * The golden Dockerfile: a skopeo-bake stage feeding a `docker:28-dind-rootless`
 * runtime that stays root (CF's Firecracker microVM is the isolation boundary,
 * and root is required to run dockerd with a working engine — see the bootstrap).
 */
export const dockerfileFor = (cachedImages: ReadonlyArray<string>): string =>
  [
    `# syntax=docker/dockerfile:1.7`,
    ...skopeoBakeStage(cachedImages, { overrideOsLinux: true }),
    ``,
    `FROM docker:28-dind-rootless`,
    `USER root`,
    ensureAfkDirs(["/var/afk/cache", "/var/log"], ["/var/afk", "/var/log"]),
    ...cacheCopyLine(cachedImages),
    ...installBootstrap({ chown: false }),
    // Run as ROOT (no `USER rootless`). On CF's Firecracker microVM the VM is the
    // isolation boundary; root is required to run dockerd with a working engine
    // (open /dev/net/tun, manage cgroups, attach containers to the host network).
    // Rootless (uid 1000) cannot — /dev/net/tun is root-only and netns ops are
    // denied. Verified on Cloudflare Containers.
    `ENTRYPOINT ["/var/afk/bootstrap.sh"]`,
    // Default CMD just keeps the container alive — the per-Run wrapper
    // (FROM afk-golden:*) overrides this with the agent's actual command.
    `CMD ["sh", "-c", "tail -f /dev/null"]`,
    ``,
  ].join("\n")

export interface CloudflareGoldenPlan {
  readonly cachedImages: ReadonlyArray<string>
  readonly builtAt: string
  readonly version: string
  readonly imageUri: string
  readonly dockerfile: string
}

/**
 * Assemble the Cloudflare golden-image build plan from config, the registry
 * `accountId`, the `bootstrap` script baked into the image, and the injected
 * `builtAt` clock seed. Pure. The bootstrap content folds into the version hash:
 * a bootstrap change must rotate the tag, or the new image pushes to the old tag
 * and CF never rolls it out.
 */
export const planCloudflareGolden = (i: {
  readonly config: AfkConfig
  readonly accountId: string
  readonly bootstrap: string
  readonly builtAt: string
}): CloudflareGoldenPlan => {
  const cachedImages = i.config.cloudflare?.cachedImages ?? []
  const version = goldenVersionHash(cachedImages, i.bootstrap)
  return {
    cachedImages,
    builtAt: i.builtAt,
    version,
    imageUri: goldenUri(i.accountId, version),
    dockerfile: dockerfileFor(cachedImages),
  }
}
