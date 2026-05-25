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

/** The pre-pull script run on the builder VM via its startup-script. Pure. */
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
