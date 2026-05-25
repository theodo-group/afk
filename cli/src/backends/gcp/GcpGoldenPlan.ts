import type { Label } from "../../adapters/gcp/Gce.ts"
import type { AfkConfig } from "../../schema/Config.ts"
import { goldenVersionHash } from "../../services/GoldenImageVersion.ts"
import {
  GCP_GOLDEN_IMAGE_FAMILY,
  GCP_LABEL_GOLDEN,
  GCP_LABEL_GOLDEN_VERSION,
} from "../../constants.ts"

// ---------------------------------------------------------------------------
// Functional core for the GCP golden-image build: pure, no I/O, no clock. The
// shell (`GcpGoldenImage`) gathers the effectful inputs (config, network
// placement) and the non-deterministic seed (`builtAt`), calls this to assemble
// the version, image name, builder startup-script, and label sets, then
// performs the builder-VM launch + `images create` the plan gates. Mirrors
// `AwsGoldenPlan.ts`. Testable with plain assertions, no Layer.
// ---------------------------------------------------------------------------

/**
 * The setup + pre-pull script that runs on the builder VM via its startup-
 * script. Three phases:
 *   1. Install Docker Engine + Compose plugin (Debian 12 doesn't ship them).
 *   2. Install Google Cloud SDK — every Run-time `gcloud …` call in the
 *      per-Run startup-script (Artifact Registry auth, Secret Manager
 *      access, GCS uploads, self-delete) depends on this being baked in.
 *      The AWS analogue is free: Amazon Linux ships `aws` preinstalled.
 *   3. Pre-pull the consumer's `cachedImages` so cold-boot Run pulls only
 *      the agent image. Pure.
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
    "set -uo pipefail",
    "export DEBIAN_FRONTEND=noninteractive",
    "",
    "echo 'afk-image-build: installing docker engine'",
    "apt-get update -y",
    "apt-get install -y --no-install-recommends \\",
    "  ca-certificates curl gnupg lsb-release apt-transport-https",
    "install -m 0755 -d /etc/apt/keyrings",
    "curl -fsSL https://download.docker.com/linux/debian/gpg \\",
    "  | gpg --dearmor -o /etc/apt/keyrings/docker.gpg",
    "chmod a+r /etc/apt/keyrings/docker.gpg",
    'echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(. /etc/os-release && echo $VERSION_CODENAME) stable" \\',
    "  > /etc/apt/sources.list.d/docker.list",
    "",
    "echo 'afk-image-build: installing google cloud sdk'",
    'echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" \\',
    "  > /etc/apt/sources.list.d/google-cloud-sdk.list",
    "curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg \\",
    "  | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg",
    "",
    "apt-get update -y",
    "apt-get install -y --no-install-recommends \\",
    "  docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin \\",
    "  google-cloud-cli",
    "systemctl enable --now docker",
    "",
    "echo 'afk-image-build: pre-pulling cached images'",
    pulls || "echo '(no cached images requested)'",
    "echo 'afk-image-build: done'",
    // Signal completion so the builder can be polled before snapshotting.
    "touch /var/afk-build-done",
  ].join("\n")
}

export interface GcpGoldenPlan {
  readonly cachedImages: ReadonlyArray<string>
  readonly builtAt: string
  readonly version: string
  readonly family: string
  readonly imageName: string
  readonly builderName: string
  readonly builderStartupScript: string
  readonly imageLabels: ReadonlyArray<Label>
}

/**
 * Sanitize a string to the GCE resource-name charset: lowercase
 * `[a-z]([-a-z0-9]*[a-z0-9])?`, ≤63 chars. Used for the builder/image names
 * derived from the ISO `builtAt`.
 */
const sanitizeName = (raw: string): string =>
  raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 63)

/**
 * Assemble the GCP golden-image build plan from config and the injected
 * `builtAt` clock seed. Pure. Prefers `gcp.cachedImages`, falling back to the
 * legacy `golden.cachedImages`.
 */
export const planGcpGolden = (i: {
  readonly config: AfkConfig
  readonly builtAt: string
}): GcpGoldenPlan => {
  const cachedImages =
    i.config.gcp?.cachedImages ?? i.config.golden?.cachedImages ?? []
  const version = goldenVersionHash(cachedImages)
  const stamp = sanitizeName(i.builtAt)
  const imageName = sanitizeName(`afk-golden-${version}-${stamp}`)
  const builderName = sanitizeName(`afk-image-builder-${version}-${stamp}`)

  return {
    cachedImages,
    builtAt: i.builtAt,
    version,
    family: GCP_GOLDEN_IMAGE_FAMILY,
    imageName,
    builderName,
    builderStartupScript: buildScript(cachedImages),
    imageLabels: [
      { key: GCP_LABEL_GOLDEN, value: "true" },
      { key: GCP_LABEL_GOLDEN_VERSION, value: version },
    ],
  }
}
