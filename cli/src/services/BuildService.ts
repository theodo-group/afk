import { Context, Effect, Layer } from "effect"
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
  readFileSync,
} from "node:fs"
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
import { ecrRepoPrefix } from "../constants.ts"
import {
  CONTENT_TAG_PREFIX,
  UnhashableSourceError,
  contentTag,
} from "./ImageTag.ts"

const ENTRYPOINT_SOURCE = resolve(
  import.meta.dir,
  "..",
  "..",
  "..",
  "entrypoint",
  "entrypoint.sh",
)

/**
 * The tag portion of an image reference, or "" when it carries none. A registry
 * host may itself hold a port (`host:5000/repo`), so only a colon that falls
 * after the last slash delimits a tag.
 */
export const tagOf = (image: string): string => {
  const colon = image.lastIndexOf(":")
  return colon > image.lastIndexOf("/") ? image.slice(colon + 1) : ""
}

/**
 * `git ls-remote` against a remote the machine cannot authenticate to fails
 * deep inside a credential helper, and the raw stderr names neither the cause
 * nor the fix. Both the build path and the `--image` path go through it.
 */
const withCredentialHint =
  (gitUrl: string) =>
  (e: GitError | UserError): GitError | UserError => {
    if (
      e._tag === "GitError" &&
      /git-credential|could not read Username|Authentication failed|Permission denied/i.test(
        e.message ?? "",
      )
    ) {
      return new UserError({
        message: `git ls-remote against ${gitUrl} failed: ${e.message}`,
        hint: "Configure a git credential helper. With the GitHub CLI: `gh auth setup-git`. Otherwise ensure your global git config has a working credential.helper for github.com.",
      })
    }
    return e
  }

const PLATFORM = "linux/amd64"

const missingDockerfile = (path: string) =>
  Effect.fail(
    new UserError({
      message: `No afk.Dockerfile found at ${path}`,
      hint: "AFK requires an `afk.Dockerfile` at the project root (namespaced away from any other Dockerfile).",
    }),
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
    /**
     * Take an image the caller vouches for rather than building one.
     *
     * This is what lets a launcher with no git work tree — the scheduler's
     * Lambda — start a Run at all. `build` reaches `git.isClean` and
     * `git.currentBranch` before it ever consults the registry cache, so even a
     * guaranteed cache hit would still force a full checkout onto the caller.
     *
     * The sha is still resolved against origin: the VM hard-checks
     * `AFK_GIT_SHA` and exits 66 on a mismatch. `git ls-remote` needs no work
     * tree, which is the whole point.
     */
    readonly adoptImage: (opts: {
      readonly image: string
      readonly ref?: string
    }) => Effect.Effect<BuildOutput, UserError | GitError | ConfigError>
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
          ).pipe(Effect.mapError(withCredentialHint(config.gitUrl)))

          const repoName = `${ecrRepoPrefix(config.aws?.resourcePrefix)}/${sourceRepoName}`
          // Docker tags allow only [A-Za-z0-9_.-]; collapse anything else to '-'
          // so refs with slashes ('refactor/afk'), colons, or other punctuation
          // don't break `docker build -t`.
          const safeBranch = branch.replace(/[^A-Za-z0-9_.-]/g, "-")
          const userDockerfile = resolve(projectRoot, "afk.Dockerfile")
          const byContent = config.image?.tag === "content"
          if (byContent && !existsSync(userDockerfile)) {
            return yield* missingDockerfile(userDockerfile)
          }
          const tag = byContent
            ? yield* Effect.try({
                try: () =>
                  contentTag({
                    contextDir: projectRoot,
                    dockerfile: readFileSync(userDockerfile, "utf8"),
                    entrypoint: readFileSync(ENTRYPOINT_SOURCE, "utf8"),
                    platform: PLATFORM,
                  }),
                catch: (e) =>
                  new UserError({
                    message: `Cannot compute the content tag: ${e instanceof UnhashableSourceError ? e.message : String(e)}`,
                    hint: 'Pin the COPY/ADD sources of afk.Dockerfile, or set image.tag to "ref" in afk.config.json.',
                  }),
              })
            : `${safeBranch}-${sha.slice(0, 12)}`
          const registryHost = yield* registry.registryUri
          const image = `${registryHost}/${repoName}:${tag}`

          // A content tag is the same for every commit, so it is usually already
          // pushed: ask the registry first, so a hit never touches docker — not
          // even `docker login`, which needs a daemon a CI job may not have.
          if (byContent && (yield* registry.imageExists(repoName, tag))) {
            yield* phase(`Image already exists, skipping build: ${image}`)
            return { image, tag, sha, branch, skipped: true }
          }

          yield* phase("Authenticating against the image registry…")
          yield* registry.ensureRepoAndAuth(repoName).pipe(
            Effect.mapError((e) =>
              byContent && e._tag === "DockerError"
                ? new UserError({
                    message: `Image ${image} is not in the registry, and this machine cannot build it: ${e.message}`,
                    hint: "Build it once from a machine with Docker (`afk build`) — needed after every change to afk.Dockerfile or the files it copies.",
                  })
                : e,
            ),
          )

          if (!byContent) {
            const exists = yield* registry.imageExists(repoName, tag)
            if (exists) {
              yield* phase(`Image already exists, skipping build: ${image}`)
              return { image, tag, sha, branch, skipped: true }
            }
          }

          if (!existsSync(userDockerfile)) {
            return yield* missingDockerfile(userDockerfile)
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
            byContent ? CONTENT_TAG_PREFIX : `${safeBranch}-`,
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
            platform: PLATFORM,
            cacheFrom: cacheFromImages,
            inlineCache: true,
          })
          yield* phase(`Building wrapper image (${image})…`)
          yield* docker.build({
            contextDir: buildDir,
            dockerfile: wrapperDockerfile,
            tag: image,
            platform: PLATFORM,
            cacheFrom: cacheFromImages,
            inlineCache: true,
          })

          yield* phase(`Pushing ${image}…`)
          yield* registry.push(image)

          return { image, tag, sha, branch, skipped: false }
        }),

      adoptImage: ({ image, ref }) =>
        Effect.gen(function* () {
          const { config } = yield* cfg.load
          // With no work tree there is no local HEAD to ask, so the ref doubles
          // as the branch. The fallback keeps `afk run --image <x>` (no --ref)
          // usable from a laptop, where a HEAD does exist.
          const branch = ref ?? (yield* git.currentBranch)
          const sha = yield* git
            .resolveRemoteRef(config.gitUrl, branch)
            .pipe(Effect.mapError(withCredentialHint(config.gitUrl)))
          return { image, tag: tagOf(image), sha, branch, skipped: true }
        }),
    })
  }),
)
