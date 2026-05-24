import { describe, it, expect } from "bun:test"
import type { AfkConfig } from "../../schema/Config.ts"
import { planLocalGolden } from "./LocalGoldenPlan.ts"
import { goldenVersionHash } from "../../services/GoldenImageVersion.ts"
import { LOCAL_GOLDEN_REPO } from "../../constants.ts"

const config = (cachedImages?: ReadonlyArray<string>): AfkConfig =>
  ({
    gitUrl: "https://github.com/acme/widget.git",
    local: cachedImages ? ({ cachedImages } as AfkConfig["local"]) : undefined,
  }) as AfkConfig

describe("planLocalGolden", () => {
  const bootstrap = "#!/bin/sh\necho local-golden\n"
  const builtAt = "2026-05-24T12:34:56.789Z"

  it("defaults to no cached images", () => {
    const plan = planLocalGolden({ config: config(), bootstrap, builtAt })
    expect(plan.cachedImages).toEqual([])
  })

  it("derives version from cache + bootstrap and tags the local repo", () => {
    const cachedImages = ["postgres:16", "redis:7"]
    const plan = planLocalGolden({
      config: config(cachedImages),
      bootstrap,
      builtAt,
    })
    const version = goldenVersionHash(cachedImages, bootstrap)
    expect(plan.version).toBe(version)
    expect(plan.imageRef).toBe(`${LOCAL_GOLDEN_REPO}:${version}`)
    expect(plan.builtAt).toBe(builtAt)
  })

  it("emits a rootless dind Dockerfile (no os override, drops to USER rootless)", () => {
    const plan = planLocalGolden({
      config: config(["node:20"]),
      bootstrap,
      builtAt,
    })
    expect(plan.dockerfile).toContain("FROM docker:28-dind-rootless")
    expect(plan.dockerfile).toContain("RUN skopeo copy docker://node:20")
    expect(plan.dockerfile).not.toContain("--override-os")
    expect(plan.dockerfile).toContain("USER rootless")
    expect(plan.dockerfile).toContain(`ENTRYPOINT ["/var/afk/bootstrap.sh"]`)
  })
})
