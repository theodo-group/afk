import { Context, Effect, Layer } from "effect"
import { existsSync, mkdirSync, writeFileSync, copyFileSync } from "node:fs"
import { resolve } from "node:path"
import { Git } from "../adapters/Git.ts"
import { Docker } from "../adapters/Docker.ts"
import { Ecr } from "../adapters/aws/Ecr.ts"
import { ConfigService } from "./ConfigService.ts"
import { UserError, AwsError, DockerError, GitError, ConfigError } from "../infra/Errors.ts"
import { ECR_REPO_PREFIX, ECR_LIFECYCLE_DAYS } from "../constants.ts"

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

export class BuildService extends Context.Tag("BuildService")<
  BuildService,
  {
    readonly build: (opts: {
      readonly region: string
      readonly ref?: string
    }) => Effect.Effect<
      BuildOutput,
      UserError | AwsError | DockerError | GitError | ConfigError
    >
  }
>() {}

export const BuildServiceLive = Layer.effect(
  BuildService,
  Effect.gen(function* () {
    const git = yield* Git
    const docker = yield* Docker
    const ecr = yield* Ecr
    const cfg = yield* ConfigService

    return BuildService.of({
      build: ({ region, ref }) =>
        Effect.gen(function* () {
          const { config, projectRoot, sourceRepoName } = yield* cfg.load

          // Hard rules: clean tree + branch pushed
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
          const sha = yield* (ref
            ? git.resolveRemoteRef(config.gitUrl, ref)
            : git.resolveRemoteRef(config.gitUrl, branch)
          ).pipe(
            Effect.mapError((e) => {
              // The most common GitError on private repos is a broken
              // credential helper. Convert to a UserError with the actionable
              // fix surfaced as a hint.
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

          // Ensure ECR repo exists
          yield* ecr.ensureRepository(region, repoName, ECR_LIFECYCLE_DAYS)
          const registry = yield* ecr.registryUri(region)
          const image = `${registry}/${repoName}:${tag}`

          // Skip if image already exists
          const exists = yield* ecr.imageExists(region, repoName, tag)
          if (exists) {
            return {
              image,
              tag,
              sha,
              branch,
              skipped: true,
            }
          }

          // Locate user Dockerfile
          const userDockerfile = resolve(projectRoot, "afk.Dockerfile")
          if (!existsSync(userDockerfile)) {
            return yield* Effect.fail(
              new UserError({
                message: `No afk.Dockerfile found at ${userDockerfile}`,
                hint: "AFK requires an `afk.Dockerfile` at the project root (namespaced away from any other Dockerfile).",
              }),
            )
          }

          // Materialize wrapper Dockerfile
          const buildDir = resolve(projectRoot, ".afk", "build")
          mkdirSync(buildDir, { recursive: true })
          copyFileSync(
            ENTRYPOINT_SOURCE,
            resolve(buildDir, "entrypoint.sh"),
          )
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

          // Pre-pull cache from the most recent previously-pushed image on
          // this branch (if any). BuildKit will warm its layer cache from it.
          // Requires we authenticate to ECR first so the pull works.
          const password = yield* ecr.getLoginPassword(region)
          yield* docker.login(registry, "AWS", password)

          const prevTags = yield* ecr.listLatestTagsByPrefix(
            region,
            repoName,
            `${branch}-`,
            1,
          )
          const cacheFromImages = prevTags.map((t) => `${registry}/${repoName}:${t}`)

          // Build user image (with inline cache + cache-from), then wrapper
          // image. BuildKit is enabled by the Docker adapter.
          yield* docker.build({
            contextDir: projectRoot,
            dockerfile: userDockerfile,
            tag: userImageTag,
            platform: "linux/amd64",
            cacheFrom: cacheFromImages,
            inlineCache: true,
          })
          yield* docker.build({
            contextDir: buildDir,
            dockerfile: wrapperDockerfile,
            tag: image,
            platform: "linux/amd64",
            cacheFrom: cacheFromImages,
            inlineCache: true,
          })

          // Push.
          yield* docker.push(image)

          return {
            image,
            tag,
            sha,
            branch,
            skipped: false,
          }
        }),
    })
  }),
)
