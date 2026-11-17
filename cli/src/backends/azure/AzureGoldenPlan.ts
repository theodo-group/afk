import type { AfkConfig } from "../../schema/Config.ts"
import { goldenVersionHash } from "../../services/GoldenImageVersion.ts"
import {
  AZURE_TAG_BUILT_AT,
  AZURE_TAG_CACHED_IMAGES,
  AZURE_TAG_GOLDEN,
  AZURE_TAG_GOLDEN_VERSION,
  AZURE_TAG_VALUE_MAX,
} from "../../constants.ts"

// ---------------------------------------------------------------------------
// Functional core for the Azure golden-image build: pure, no I/O, no clock.
// The shell (`AzureGoldenImage`) injects `builtAt`, then drives the builder VM
// through the plan: run `buildScript` over the VM agent, deprovision, capture a
// generalized managed image, delete the builder. Mirrors `GcpGoldenPlan.ts`.
// ---------------------------------------------------------------------------

/**
 * The builder's setup + pre-pull script, run through `az vm run-command`:
 *   1. Docker Engine + Compose plugin (Ubuntu ships neither).
 *   2. The Azure CLI — every Run-time call in the custom data (managed-identity
 *      sign-in, ACR login, Key Vault, Blob/Table writes, self-reclaim) is `az`.
 *   3. Pre-pull the consumer's `cachedImages`, so a Run pulls only its agent
 *      image. Pure.
 */
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
    "export DEBIAN_FRONTEND=noninteractive",
    "",
    "echo 'afk-image-build: installing docker engine'",
    "apt-get update -y",
    "apt-get install -y --no-install-recommends ca-certificates curl gnupg lsb-release",
    "install -m 0755 -d /etc/apt/keyrings",
    "curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg",
    "chmod a+r /etc/apt/keyrings/docker.gpg",
    'echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list',
    "apt-get update -y",
    "apt-get install -y --no-install-recommends docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin",
    "systemctl enable --now docker",
    "",
    "echo 'afk-image-build: installing azure cli'",
    "curl -fsSL https://aka.ms/InstallAzureCLIDeb | bash",
    "",
    "echo 'afk-image-build: pre-pulling cached images'",
    "set +e",
    pulls || "echo '(no cached images requested)'",
    "echo 'afk-image-build: done'",
  ].join("\n")
}

/** Run last on the builder: strip machine identity so the image generalizes. */
export const DEPROVISION_SCRIPT =
  "waagent -deprovision+user -force && echo 'afk-image-build: deprovisioned'"

export interface AzureGoldenPlan {
  readonly cachedImages: ReadonlyArray<string>
  readonly builtAt: string
  readonly version: string
  readonly imageName: string
  readonly builderName: string
  readonly builderScript: string
  readonly imageTags: Readonly<Record<string, string>>
}

/** [a-z0-9-], ≤64 chars — valid for both a VM and an image name. */
const sanitizeName = (raw: string): string =>
  raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64)

/**
 * The pre-pulled list rides a tag (≤256 chars). A list too long for one is
 * truncated whole entries at a time and marked, so `afk golden ls` shows what
 * fit rather than an unparseable fragment.
 */
export const cachedImagesTag = (images: ReadonlyArray<string>): string => {
  const full = JSON.stringify(images)
  if (full.length <= AZURE_TAG_VALUE_MAX) return full
  const fit = images.reduce<ReadonlyArray<string>>(
    (acc, img) =>
      JSON.stringify([...acc, img, "…"]).length <= AZURE_TAG_VALUE_MAX
        ? [...acc, img]
        : acc,
    [],
  )
  return JSON.stringify([...fit, "…"])
}

/** Assemble the golden build plan. Pure. Prefers `azure.cachedImages`. */
export const planAzureGolden = (i: {
  readonly config: AfkConfig
  readonly builtAt: string
}): AzureGoldenPlan => {
  const cachedImages =
    i.config.azure?.cachedImages ?? i.config.golden?.cachedImages ?? []
  const version = goldenVersionHash(cachedImages)
  const stamp = sanitizeName(i.builtAt)
  return {
    cachedImages,
    builtAt: i.builtAt,
    version,
    imageName: sanitizeName(`afk-golden-${version}-${stamp}`),
    builderName: sanitizeName(`afk-builder-${version}-${stamp}`),
    builderScript: buildScript(cachedImages),
    imageTags: {
      [AZURE_TAG_GOLDEN]: "true",
      [AZURE_TAG_GOLDEN_VERSION]: version,
      [AZURE_TAG_BUILT_AT]: i.builtAt,
      [AZURE_TAG_CACHED_IMAGES]: cachedImagesTag(cachedImages),
    },
  }
}
