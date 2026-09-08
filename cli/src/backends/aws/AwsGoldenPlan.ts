import type { AfkConfig } from "../../schema/Config.ts"
import { goldenVersionHash } from "../../services/GoldenImageVersion.ts"
import {
  TAG_GOLDEN,
  TAG_GOLDEN_BUILT_AT,
  TAG_GOLDEN_CACHED_IMAGES,
  TAG_GOLDEN_VERSION,
  TAG_MANAGED,
} from "../../constants.ts"

// ---------------------------------------------------------------------------
// Functional core for the AWS golden-image build: pure, no I/O, no clock. The
// shell (`AwsGoldenImage`) gathers the effectful inputs (config, network
// placement, base AMI) and the non-deterministic seed (`builtAt`), calls this
// to assemble the version, names, builder user-data, pre-pull script, and the
// two tag sets, then performs the launch/snapshot effects the plan gates.
// Testable with plain assertions, no Layer.
// ---------------------------------------------------------------------------

export type GoldenTag = { readonly key: string; readonly value: string }

/**
 * An ECR image reference: `<account>.dkr.ecr.<region>.amazonaws.com/<repo>:<tag>`.
 * Matched so the builder can authenticate before pulling — a private image is
 * otherwise refused, and the pre-pull only warns, leaving the developer with a
 * Golden Image that silently lacks the very image they asked to cache.
 */
const ECR_IMAGE_REF = /^([0-9]{12})\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com\//

/**
 * `docker login` for every distinct ECR registry the cached images live in,
 * using the builder's instance profile. Public images need none, so a list
 * without ECR references renders no login at all.
 */
const renderEcrLogins = (cachedImages: ReadonlyArray<string>): string => {
  const registries = new Map<string, string>()
  for (const img of cachedImages) {
    const m = ECR_IMAGE_REF.exec(img)
    if (m) registries.set(`${m[1]}.dkr.ecr.${m[2]}.amazonaws.com`, m[2]!)
  }
  if (registries.size === 0)
    return "# (no private registry to authenticate against)"
  return Array.from(registries)
    .map(
      ([host, region]) =>
        `aws --region ${region} ecr get-login-password | docker login --username AWS --password-stdin ${host}`,
    )
    .join("\n")
}

/** The pre-pull script run on the builder VM via SSM. Pure. */
export const buildScript = (cachedImages: ReadonlyArray<string>): string => {
  const pulls = cachedImages
    .map(
      (img) =>
        `docker pull ${img} || echo "warning: failed to pre-pull ${img}"`,
    )
    .join("\n")
  return [
    "#!/bin/bash",
    "set -euo pipefail",
    "echo 'afk-image-build: installing Docker'",
    "dnf install -y docker",
    "systemctl enable --now docker",
    "echo 'afk-image-build: installing docker compose plugin'",
    "mkdir -p /usr/libexec/docker/cli-plugins",
    "DOCKER_COMPOSE_VERSION=v2.32.4",
    "curl -fsSL -o /usr/libexec/docker/cli-plugins/docker-compose \\",
    "  https://github.com/docker/compose/releases/download/$DOCKER_COMPOSE_VERSION/docker-compose-linux-x86_64",
    "chmod +x /usr/libexec/docker/cli-plugins/docker-compose",
    "echo 'afk-image-build: authenticating against private registries'",
    renderEcrLogins(cachedImages),
    "echo 'afk-image-build: pre-pulling cached images'",
    pulls || "echo '(no cached images requested)'",
    "echo 'afk-image-build: cleaning docker apt cache to reduce AMI size'",
    "docker image prune -f >/dev/null || true",
    "echo 'afk-image-build: done'",
  ].join("\n")
}

export interface AwsGoldenPlan {
  readonly cachedImages: ReadonlyArray<string>
  readonly builtAt: string
  readonly version: string
  readonly amiName: string
  readonly description: string
  /** Minimal user-data: just enough for the SSM agent to come up. */
  readonly builderUserData: string
  readonly builderTags: ReadonlyArray<GoldenTag>
  readonly imageTags: ReadonlyArray<GoldenTag>
  readonly script: string
}

/**
 * Assemble the AWS golden-image build plan from config and the injected
 * `builtAt` clock seed. Pure. Prefers `aws.cachedImages` (canonical), falling
 * back to legacy `golden.cachedImages`.
 */
export const planAwsGolden = (i: {
  readonly config: AfkConfig
  readonly builtAt: string
}): AwsGoldenPlan => {
  const cachedImages =
    i.config.aws?.cachedImages ?? i.config.golden?.cachedImages ?? []
  const version = goldenVersionHash(cachedImages)
  const amiName = `afk-golden-${version}-${i.builtAt.replace(/[:.]/g, "-")}`

  const builderUserData = [
    "#!/bin/bash",
    "set -euo pipefail",
    "echo afk-builder ready",
  ].join("\n")

  return {
    cachedImages,
    builtAt: i.builtAt,
    version,
    amiName,
    description: `AFK golden image (${cachedImages.length} cached images)`,
    builderUserData,
    builderTags: [
      { key: TAG_MANAGED, value: "true" },
      { key: "Name", value: `afk-image-builder-${version}` },
      { key: "afk:purpose", value: "image-builder" },
    ],
    imageTags: [
      { key: TAG_GOLDEN, value: "true" },
      { key: TAG_GOLDEN_VERSION, value: version },
      { key: TAG_GOLDEN_BUILT_AT, value: i.builtAt },
      { key: TAG_GOLDEN_CACHED_IMAGES, value: cachedImages.join(",") },
      { key: "Name", value: amiName },
    ],
    script: buildScript(cachedImages),
  }
}
