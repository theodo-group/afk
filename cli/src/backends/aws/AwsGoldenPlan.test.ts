import { describe, it, expect } from "bun:test"
import type { AfkConfig } from "../../schema/Config.ts"
import { planAwsGolden } from "./AwsGoldenPlan.ts"
import { goldenVersionHash } from "../../services/GoldenImageVersion.ts"
import {
  TAG_GOLDEN,
  TAG_GOLDEN_BUILT_AT,
  TAG_GOLDEN_CACHED_IMAGES,
  TAG_GOLDEN_VERSION,
} from "../../constants.ts"

const config = (overrides: Partial<AfkConfig> = {}): AfkConfig =>
  ({
    gitUrl: "https://github.com/acme/widget.git",
    ...overrides,
  }) as AfkConfig

const tagValue = (
  tags: ReadonlyArray<{ key: string; value: string }>,
  key: string,
): string | undefined => tags.find((t) => t.key === key)?.value

describe("planAwsGolden", () => {
  const builtAt = "2026-05-24T12:34:56.789Z"

  it("prefers aws.cachedImages over legacy golden.cachedImages", () => {
    const plan = planAwsGolden({
      config: config({
        aws: { cachedImages: ["postgres:16"] } as AfkConfig["aws"],
        golden: { cachedImages: ["redis:7"] } as AfkConfig["golden"],
      }),
      builtAt,
    })
    expect(plan.cachedImages).toEqual(["postgres:16"])
  })

  it("falls back to legacy golden.cachedImages", () => {
    const plan = planAwsGolden({
      config: config({ golden: { cachedImages: ["redis:7"] } as AfkConfig["golden"] }),
      builtAt,
    })
    expect(plan.cachedImages).toEqual(["redis:7"])
  })

  it("defaults to no cached images", () => {
    const plan = planAwsGolden({ config: config(), builtAt })
    expect(plan.cachedImages).toEqual([])
  })

  it("derives version from cached images and bakes a clock-safe AMI name", () => {
    const cachedImages = ["postgres:16", "redis:7"]
    const plan = planAwsGolden({
      config: config({ aws: { cachedImages } as AfkConfig["aws"] }),
      builtAt,
    })
    const version = goldenVersionHash(cachedImages)
    expect(plan.version).toBe(version)
    expect(plan.amiName).toBe(`afk-golden-${version}-2026-05-24T12-34-56-789Z`)
    expect(plan.amiName).not.toContain(":")
    expect(plan.amiName).not.toContain(".")
    expect(plan.builtAt).toBe(builtAt)
  })

  it("assembles the golden image tags from version, builtAt and cached images", () => {
    const cachedImages = ["postgres:16", "redis:7"]
    const plan = planAwsGolden({
      config: config({ aws: { cachedImages } as AfkConfig["aws"] }),
      builtAt,
    })
    expect(tagValue(plan.imageTags, TAG_GOLDEN)).toBe("true")
    expect(tagValue(plan.imageTags, TAG_GOLDEN_VERSION)).toBe(plan.version)
    expect(tagValue(plan.imageTags, TAG_GOLDEN_BUILT_AT)).toBe(builtAt)
    expect(tagValue(plan.imageTags, TAG_GOLDEN_CACHED_IMAGES)).toBe(
      "postgres:16,redis:7",
    )
    expect(tagValue(plan.imageTags, "Name")).toBe(plan.amiName)
  })

  it("tags the builder VM as a managed image-builder", () => {
    const plan = planAwsGolden({ config: config(), builtAt })
    expect(tagValue(plan.builderTags, "afk:purpose")).toBe("image-builder")
    expect(tagValue(plan.builderTags, "Name")).toBe(
      `afk-image-builder-${plan.version}`,
    )
  })

  it("emits a pre-pull line per cached image and the done marker", () => {
    const plan = planAwsGolden({
      config: config({ aws: { cachedImages: ["postgres:16"] } as AfkConfig["aws"] }),
      builtAt,
    })
    expect(plan.script).toContain("docker pull postgres:16")
    expect(plan.script).toContain("afk-image-build: done")
  })

  it("notes when no cached images are requested", () => {
    const plan = planAwsGolden({ config: config(), builtAt })
    expect(plan.script).toContain("(no cached images requested)")
  })
})
