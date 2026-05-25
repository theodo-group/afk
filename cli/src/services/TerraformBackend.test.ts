import { describe, expect, it } from "bun:test"
import { detectBackendRegionDrift } from "./TerraformBackend.ts"

const backendTf = (region: string) =>
  [
    `terraform {`,
    `  backend "s3" {`,
    `    bucket       = "afk-tf-state-123-${region}"`,
    `    key          = "afk/terraform.tfstate"`,
    `    region       = "${region}"`,
    `    encrypt      = true`,
    `  }`,
    `}`,
  ].join("\n")

describe("detectBackendRegionDrift", () => {
  it("reports no drift when baked region matches config", () => {
    expect(
      detectBackendRegionDrift({
        backendTf: backendTf("eu-west-1"),
        configRegion: "eu-west-1",
      }),
    ).toEqual({ bakedRegion: "eu-west-1", drifted: false })
  })

  it("reports drift when baked region differs from config", () => {
    expect(
      detectBackendRegionDrift({
        backendTf: backendTf("us-east-1"),
        configRegion: "eu-west-1",
      }),
    ).toEqual({ bakedRegion: "us-east-1", drifted: true })
  })

  it("does not flag drift when no region is present to compare", () => {
    expect(
      detectBackendRegionDrift({
        backendTf: `terraform {}`,
        configRegion: "eu-west-1",
      }),
    ).toEqual({ bakedRegion: undefined, drifted: false })
  })
})
