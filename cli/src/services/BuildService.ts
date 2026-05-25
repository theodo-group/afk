import { Context, Effect, Layer } from "effect"
import { existsSync, mkdirSync, writeFileSync, copyFileSync } from "node:fs"
import { resolve } from "node:path"
import { Git } from "../adapters/Git.ts"
import { Docker } from "../adapters/Docker.ts"
import { ImageRegistry } from "./backend/ImageRegistry.ts"
import { ConfigService } from "./ConfigService.ts"
import { Output } from "../infra/Output.ts"
import {
  UserError,
  AwsError,
  CloudflareError,
  GcpError,
  DockerError,
  GitError,
  ConfigError,
} from "../infra/Errors.ts"
import { ECR_REPO_PREFIX } from "../constants.ts"

const ENTRYPOINT_SOURCE = resolve(
  import.meta.dir,
  "..",
  "..",
  "..",
  "entrypoint",
  "entrypoint.sh",
)

export interface BuildOutput {
  readonly image: string
  readonly tag: string
  readonly sha: string
  readonly branch: string
  readonly skipped: boolean
}

/**
 * Cross-Backend build pipeline. Performs all the steps that look the same
 * regardless of registry (git checks, wrapper materialization, docker build),
 * delegating registry-side ops to the active Backend's `ImageRegistry`.
 *
 * The `region` argument on `build({region, ref})` is retained for the AWS path
 * but is unused on Backends where region isn't a registry concern (CF). New
 * call sites should prefer leaving it implicit (it's just a passthrough).
 */
export class BuildService extends Context.Tag("BuildService")<
  BuildService,
  {
    readonly build: (opts: {
      readonly region?: string
      readonly ref?: string
    }) => Effect.Effect<
      BuildOutput,
      | UserError
      | AwsError
      | CloudflareError
      | GcpError
      | DockerError
      | GitError
      | ConfigError
    >
  }
>() {}

export const BuildServiceLive = Layer.effect(
  BuildService,
  Effect.gen(function* () {
    const git = yield* Git
    const docker = yield* Docker
    const registry = yield* ImageRegistry
    const cfg = yield* ConfigService
    const out = yield* Output

    // Phase markers go to stderr (`out.print` writes stdout via console.log,
    // which would clobber `--json`). Honour `mode === "json"` by going silent.
    const phase = (msg: string) =>
      out.mode === "json" ? Effect.void : out.print(msg)

    return BuildService.of({
      build: ({ ref }) =>
        Effect.gen(function* () {
          const { config, projectRoot, sourceRepoName } = yield* cfg.load

          // Clean tree + a ref that resolves on origin together guarantee the
          // cloud build is exactly what's on origin — no dirty or unpushed state.
          const clean = yield* git.isClean
          if (!clean) {
            return yield* Effect.fail(
              new UserError({
                message: "Working tree is dirty.",
                hint: "Commit or stash your changes before building.",
              }),
            )
          }
          const branch = yield* git.currentBranch
          yield* phase(`Resolving ${ref ?? branch} against ${config.gitUrl}…`)
          const sha = yield* (
            ref
              ? git.resolveRemoteRef(config.gitUrl, ref)
              : git.resolveRemoteRef(config.gitUrl, branch)
          ).pipe(
            Effect.mapError((e) => {
              if (
                e._tag === "GitError" &&
                /git-credential|could not read Username|Authentication failed|Permission denied/i.test(
                  e.message ?? "",
                )
              ) {
                return new UserError({
                  message: `git ls-remote against ${config.gitUrl} failed: ${e.message}`,
                  hint: "Configure a git credential helper. With the GitHub CLI: `gh auth setup-git`. Otherwise ensure your global git config has a working credential.helper for github.com.",
                })
              }
              return e
            }),
          )

          const repoName = `${ECR_REPO_PREFIX}/${sourceRepoName}`
          const tag = `${branch}-${sha.slice(0, 12)}`

          yield* phase("Authenticating against the image registry…")
          yield* registry.ensureRepoAndAuth(repoName)
          const registryHost = yield* registry.registryUri
          const image = `${registryHost}/${repoName}:${tag}`

          const exists = yield* registry.imageExists(repoName, tag)
          if (exists) {
            yield* phase(`Image already exists, skipping build: ${image}`)
            return { image, tag, sha, branch, skipped: true }
          }

          const userDockerfile = resolve(projectRoot, "afk.Dockerfile")
          if (!existsSync(userDockerfile)) {
            return yield* Effect.fail(
              new UserError({
                message: `No afk.Dockerfile found at ${userDockerfile}`,
                hint: "AFK requires an `afk.Dockerfile` at the project root (namespaced away from any other Dockerfile).",
              }),
            )
          }

          const buildDir = resolve(projectRoot, ".afk", "build")
          mkdirSync(buildDir, { recursive: true })
          copyFileSync(ENTRYPOINT_SOURCE, resolve(buildDir, "entrypoint.sh"))
          copyFileSync(userDockerfile, resolve(buildDir, "Dockerfile.user"))
          const userImageTag = `afk-user:${tag}`
          const wrapperDockerfile = resolve(buildDir, "Dockerfile.wrapper")
          writeFileSync(
            wrapperDockerfile,
            [
              `FROM ${userImageTag}`,
              `COPY entrypoint.sh /afk/entrypoint.sh`,
              `RUN chmod +x /afk/entrypoint.sh`,
              `ENTRYPOINT ["/afk/entrypoint.sh"]`,
              "",
            ].join("\n"),
          )

          const prevTags = yield* registry.listLatestTagsByPrefix(
            repoName,
            `${branch}-`,
            1,
          )
          const cacheFromImages = prevTags.map(
            (t) => `${registryHost}/${repoName}:${t}`,
          )

          yield* phase(`Building user image (${userImageTag})…`)
          yield* docker.build({
            contextDir: projectRoot,
            dockerfile: userDockerfile,
            tag: userImageTag,
            platform: "linux/amd64",
            cacheFrom: cacheFromImages,
            inlineCache: true,
          })
          yield* phase(`Building wrapper image (${image})…`)
          yield* docker.build({
            contextDir: buildDir,
            dockerfile: wrapperDockerfile,
            tag: image,
            platform: "linux/amd64",
            cacheFrom: cacheFromImages,
            inlineCache: true,
          })

          yield* phase(`Pushing ${image}…`)
          yield* registry.push(image)

          return { image, tag, sha, branch, skipped: false }
        }),
    })
  }),
)
