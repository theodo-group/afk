import { describe, it, expect } from "bun:test"
import type { AfkConfig } from "../../schema/Config.ts"
import { buildScript, planGcpGolden } from "./GcpGoldenPlan.ts"
import { goldenVersionHash } from "../../services/GoldenImageVersion.ts"
import {
  GCP_GOLDEN_IMAGE_FAMILY,
  GCP_LABEL_GOLDEN,
  GCP_LABEL_GOLDEN_VERSION,
} from "../../constants.ts"

const config = (overrides: Partial<AfkConfig> = {}): AfkConfig =>
  ({
    gitUrl: "https://github.com/acme/widget.git",
    ...overrides,
  }) as AfkConfig

const labelValue = (
  labels: ReadonlyArray<{ key: string; value: string }>,
  key: string,
): string | undefined => labels.find((l) => l.key === key)?.value

describe("planGcpGolden", () => {
  const builtAt = "2026-05-24T12:34:56.789Z"

  it("prefers gcp.cachedImages over legacy golden.cachedImages", () => {
    const plan = planGcpGolden({
      config: config({
        gcp: { cachedImages: ["postgres:16"] } as AfkConfig["gcp"],
        golden: { cachedImages: ["redis:7"] } as AfkConfig["golden"],
      }),
      builtAt,
    })
    expect(plan.cachedImages).toEqual(["postgres:16"])
  })

  it("falls back to legacy golden.cachedImages, then to empty", () => {
    expect(
      planGcpGolden({
        config: config({
          golden: { cachedImages: ["redis:7"] } as AfkConfig["golden"],
        }),
        builtAt,
      }).cachedImages,
    ).toEqual(["redis:7"])
    expect(planGcpGolden({ config: config(), builtAt }).cachedImages).toEqual(
      [],
    )
  })

  it("derives a deterministic version hash from the cached images", () => {
    const images = ["postgres:16", "redis:7"]
    const plan = planGcpGolden({
      config: config({ gcp: { cachedImages: images } as AfkConfig["gcp"] }),
      builtAt,
    })
    expect(plan.version).toBe(goldenVersionHash(images))
  })

  it("tags the image with the golden + version labels and the family", () => {
    const plan = planGcpGolden({
      config: config({
        gcp: { cachedImages: ["postgres:16"] } as AfkConfig["gcp"],
      }),
      builtAt,
    })
    expect(plan.family).toBe(GCP_GOLDEN_IMAGE_FAMILY)
    expect(labelValue(plan.imageLabels, GCP_LABEL_GOLDEN)).toBe("true")
    expect(labelValue(plan.imageLabels, GCP_LABEL_GOLDEN_VERSION)).toBe(
      plan.version,
    )
  })

  it("produces image/builder names within the GCE name charset (≤63, [a-z0-9-])", () => {
    const plan = planGcpGolden({ config: config(), builtAt })
    for (const name of [plan.imageName, plan.builderName]) {
      expect(name.length).toBeLessThanOrEqual(63)
      expect(name).toMatch(/^[a-z]([-a-z0-9]*[a-z0-9])?$/)
    }
  })

  it("buildScript pre-pulls each image and signals completion", () => {
    const script = buildScript(["postgres:16", "redis:7"])
    expect(script).toContain("docker pull postgres:16")
    expect(script).toContain("docker pull redis:7")
    expect(script).toContain("touch /var/afk-build-done")
  })

  it("buildScript handles the no-images case without an empty pull", () => {
    const script = buildScript([])
    expect(script).not.toContain("docker pull")
    expect(script).toContain("(no cached images requested)")
  })
})
