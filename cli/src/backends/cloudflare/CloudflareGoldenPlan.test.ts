import { describe, it, expect } from "bun:test"
import type { AfkConfig } from "../../schema/Config.ts"
import { planCloudflareGolden, goldenUri } from "./CloudflareGoldenPlan.ts"
import { goldenVersionHash } from "../../services/GoldenImageVersion.ts"

const config = (cachedImages?: ReadonlyArray<string>): AfkConfig =>
  ({
    gitUrl: "https://github.com/acme/widget.git",
    cloudflare: cachedImages
      ? ({ cachedImages } as AfkConfig["cloudflare"])
      : undefined,
  }) as AfkConfig

describe("planCloudflareGolden", () => {
  const accountId = "acct123"
  const bootstrap = "#!/bin/sh\necho golden\n"
  const builtAt = "2026-05-24T12:34:56.789Z"

  it("defaults to no cached images", () => {
    const plan = planCloudflareGolden({
      config: config(),
      accountId,
      bootstrap,
      builtAt,
    })
    expect(plan.cachedImages).toEqual([])
  })

  it("folds cachedImages and bootstrap into the version, and builds the URI", () => {
    const cachedImages = ["postgres:16", "redis:7"]
    const plan = planCloudflareGolden({
      config: config(cachedImages),
      accountId,
      bootstrap,
      builtAt,
    })
    const version = goldenVersionHash(cachedImages, bootstrap)
    expect(plan.version).toBe(version)
    expect(plan.imageUri).toBe(goldenUri(accountId, version))
    expect(plan.builtAt).toBe(builtAt)
  })

  it("rotates the version when the bootstrap changes", () => {
    const cachedImages = ["postgres:16"]
    const a = planCloudflareGolden({
      config: config(cachedImages),
      accountId,
      bootstrap,
      builtAt,
    })
    const b = planCloudflareGolden({
      config: config(cachedImages),
      accountId,
      bootstrap: bootstrap + "# changed\n",
      builtAt,
    })
    expect(a.version).not.toBe(b.version)
  })

  it("emits a root dind Dockerfile that bakes the cache and copies bootstrap", () => {
    const plan = planCloudflareGolden({
      config: config(["postgres:16"]),
      accountId,
      bootstrap,
      builtAt,
    })
    expect(plan.dockerfile).toContain("FROM docker:28-dind-rootless")
    expect(plan.dockerfile).toContain(
      "RUN skopeo copy --override-os linux docker://postgres:16",
    )
    expect(plan.dockerfile).toContain("COPY --from=skopeo-bake /out/")
    expect(plan.dockerfile).toContain(`ENTRYPOINT ["/var/afk/bootstrap.sh"]`)
    // CF stays root — no `USER rootless` line.
    expect(plan.dockerfile).not.toContain("USER rootless")
  })
})
