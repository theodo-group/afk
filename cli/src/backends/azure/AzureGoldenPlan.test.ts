import { describe, expect, it } from "bun:test"
import type { AfkConfig } from "../../schema/Config.ts"
import { cachedImagesTag, planAzureGolden } from "./AzureGoldenPlan.ts"
import {
  AZURE_TAG_BUILT_AT,
  AZURE_TAG_GOLDEN,
  AZURE_TAG_VALUE_MAX,
} from "../../constants.ts"

const config = (cachedImages: ReadonlyArray<string>) =>
  ({ gitUrl: "x", azure: { cachedImages } }) as AfkConfig

describe("planAzureGolden", () => {
  it("names the image and builder from the version and the build time", () => {
    const plan = planAzureGolden({
      config: config(["postgres:16"]),
      builtAt: "2026-11-12T10:00:00.000Z",
    })
    expect(plan.imageName).toMatch(
      /^afk-golden-[a-z0-9-]+-2026-11-12t10-00-00-000z$/,
    )
    expect(plan.builderName.length).toBeLessThanOrEqual(64)
    expect(plan.imageTags[AZURE_TAG_GOLDEN]).toBe("true")
    expect(plan.imageTags[AZURE_TAG_BUILT_AT]).toBe("2026-11-12T10:00:00.000Z")
    expect(plan.builderScript).toContain("docker pull postgres:16")
    expect(plan.builderScript).toContain("InstallAzureCLIDeb")
  })
})

describe("cachedImagesTag", () => {
  it("keeps a short list whole", () => {
    expect(cachedImagesTag(["a", "b"])).toBe('["a","b"]')
  })

  it("truncates a long list whole entries at a time, within the tag cap", () => {
    const images = Array.from(
      { length: 40 },
      (_, i) => `registry.example/img-${i}:latest`,
    )
    const tag = cachedImagesTag(images)
    expect(tag.length).toBeLessThanOrEqual(AZURE_TAG_VALUE_MAX)
    const parsed = JSON.parse(tag) as ReadonlyArray<string>
    expect(parsed.at(-1)).toBe("…")
    expect(images).toContain(parsed[0] ?? "")
  })
})
