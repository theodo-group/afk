import { Effect, Layer } from "effect"
import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { Docker } from "../../adapters/Docker.ts"
import { Subprocess } from "../../infra/Subprocess.ts"
import { ConfigService } from "../../services/ConfigService.ts"
import {
  GoldenImageStore,
  type GoldenImage,
} from "../../services/backend/GoldenImage.ts"
import { DockerError } from "../../infra/Errors.ts"
import { LOCAL_GOLDEN_REPO } from "../../constants.ts"
import { LOCAL_BOOTSTRAP } from "./localBootstrap.ts"
import { planLocalGolden } from "./LocalGoldenPlan.ts"

interface DockerImageRow {
  readonly Repository: string
  readonly Tag: string
  readonly ID: string
  readonly CreatedAt?: string
}

/**
 * Local implementation of the Golden Image store. The artifact is a
 * `docker:28-dind-rootless` image with the configured `local.cachedImages`
 * skopeo-baked into `/var/afk/cache/*.tar` plus the local bootstrap baked in,
 * built into the developer's own Docker daemon as `afk-golden-local:<version>`.
 * Unlike the cloud Backends it is never pushed to a registry — it lives only in
 * the local daemon, which is where every local Run boots from.
 */
export const LocalGoldenImageLive = Layer.effect(
  GoldenImageStore,
  Effect.gen(function* () {
    const docker = yield* Docker
    const sub = yield* Subprocess
    const cfg = yield* ConfigService

    const list = Effect.gen(function* () {
      const rows = yield* sub
        .run("docker", ["images", LOCAL_GOLDEN_REPO, "--format", "{{json .}}"])
        .pipe(Effect.either)
      if (rows._tag === "Left") return [] as ReadonlyArray<GoldenImage>
      return rows.right.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as DockerImageRow]
          } catch {
            return []
          }
        })
        .filter((r) => r.Tag !== "<none>")
        .map(
          (r): GoldenImage => ({
            id: `${r.Repository}:${r.Tag}`,
            displayName: r.Tag,
            version: r.Tag,
            builtAt: r.CreatedAt ?? "",
            cachedImages: [],
            ready: true,
            backendDetails: { imageId: r.ID },
          }),
        )
    })

    // `docker images` lists newest-first, so the head is the latest build.
    const findLatest = list.pipe(Effect.map((images) => images[0] ?? null))

    const remove = (id: string) =>
      sub.run("docker", ["rmi", id]).pipe(
        Effect.asVoid,
        Effect.mapError(
          (e) =>
            new DockerError({
              operation: "rmi",
              message: e.stderr || String(e),
            }),
        ),
      )

    const build = Effect.gen(function* () {
      const { config, projectRoot } = yield* cfg.load

      const plan = planLocalGolden({
        config,
        bootstrap: LOCAL_BOOTSTRAP,
        builtAt: new Date().toISOString(),
      })
      const { cachedImages, version, builtAt, imageRef } = plan

      const buildDir = resolve(projectRoot, ".afk", "local-golden-build")
      mkdirSync(buildDir, { recursive: true })
      writeFileSync(resolve(buildDir, "Dockerfile"), plan.dockerfile)
      writeFileSync(resolve(buildDir, "bootstrap.sh"), LOCAL_BOOTSTRAP, {
        mode: 0o755,
      })

      // Built into the local daemon at the host's native architecture (no
      // --platform, no push): this image only ever runs here.
      yield* docker.build({
        contextDir: buildDir,
        dockerfile: resolve(buildDir, "Dockerfile"),
        tag: imageRef,
        inlineCache: true,
      })

      return {
        id: imageRef,
        displayName: version,
        version,
        builtAt,
        cachedImages,
        note: "built into the local Docker daemon (not pushed)",
      }
    })

    return GoldenImageStore.of({ build, list, findLatest, remove })
  }),
)
