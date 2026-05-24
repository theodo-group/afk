import type { AfkConfig } from "../../schema/Config.ts"
import { goldenVersionHash } from "../../services/GoldenImageVersion.ts"
import {
  cacheCopyLine,
  ensureAfkDirs,
  installBootstrap,
  skopeoBakeStage,
} from "../../services/DindGolden.ts"
import { LOCAL_GOLDEN_REPO } from "../../constants.ts"

// ---------------------------------------------------------------------------
// Functional core for the Local golden-image build: pure, no I/O, no clock. The
// shell (`LocalGoldenImage`) gathers the effectful inputs (config, the bootstrap
// baked into the image) and the non-deterministic seed (`builtAt`), calls this to
// assemble the version, image ref, and Dockerfile, then performs the local
// `docker build` the plan gates. Testable with plain assertions, no Layer.
// ---------------------------------------------------------------------------

/**
 * The golden Dockerfile: a skopeo-bake stage feeding a `docker:28-dind-rootless`
 * runtime that drops to `USER rootless` — on a developer's own machine the
 * container is the isolation boundary and rootless dind avoids needing
 * `--privileged` at `docker run`. Mirrors the Cloudflare Golden Image shape.
 */
export const dockerfileFor = (cachedImages: ReadonlyArray<string>): string =>
  [
    `# syntax=docker/dockerfile:1.7`,
    ...skopeoBakeStage(cachedImages, { overrideOsLinux: false }),
    ``,
    `FROM docker:28-dind-rootless`,
    `USER root`,
    ensureAfkDirs(["/var/afk/cache", "/var/afk/run"], ["/var/afk"]),
    ...cacheCopyLine(cachedImages),
    ...installBootstrap({ chown: true }),
    `USER rootless`,
    `ENTRYPOINT ["/var/afk/bootstrap.sh"]`,
    `CMD ["sh", "-c", "tail -f /dev/null"]`,
    ``,
  ].join("\n")

export interface LocalGoldenPlan {
  readonly cachedImages: ReadonlyArray<string>
  readonly builtAt: string
  readonly version: string
  readonly imageRef: string
  readonly dockerfile: string
}

/**
 * Assemble the Local golden-image build plan from config, the `bootstrap` script
 * baked into the image, and the injected `builtAt` clock seed. Pure. The bootstrap
 * content folds into the version hash so a bootstrap change rotates the local tag.
 */
export const planLocalGolden = (i: {
  readonly config: AfkConfig
  readonly bootstrap: string
  readonly builtAt: string
}): LocalGoldenPlan => {
  const cachedImages = i.config.local?.cachedImages ?? []
  const version = goldenVersionHash(cachedImages, i.bootstrap)
  return {
    cachedImages,
    builtAt: i.builtAt,
    version,
    imageRef: `${LOCAL_GOLDEN_REPO}:${version}`,
    dockerfile: dockerfileFor(cachedImages),
  }
}
