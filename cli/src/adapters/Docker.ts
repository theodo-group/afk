import { Context, Effect, Layer } from "effect"
import { Subprocess } from "../infra/Subprocess.ts"
import { DockerError } from "../infra/Errors.ts"

export interface BuildOptions {
  readonly contextDir: string
  /** Path to the (wrapper) Dockerfile relative to contextDir. */
  readonly dockerfile: string
  readonly tag: string
  readonly platform?: string
  /**
   * Images to pull as BuildKit cache sources before the build. Typically
   * the previous-pushed tag of the same branch. Missing tags are silently
   * skipped by BuildKit.
   */
  readonly cacheFrom?: ReadonlyArray<string>
  /**
   * When true, embed inline cache metadata into the built image so it can
   * be used as `cacheFrom` by future builds.
   */
  readonly inlineCache?: boolean
}

export class Docker extends Context.Tag("Docker")<
  Docker,
  {
    readonly build: (opts: BuildOptions) => Effect.Effect<void, DockerError>
    readonly tag: (
      source: string,
      target: string,
    ) => Effect.Effect<void, DockerError>
    readonly push: (image: string) => Effect.Effect<void, DockerError>
    readonly login: (
      registry: string,
      username: string,
      password: string,
    ) => Effect.Effect<void, DockerError>
  }
>() {}

export const DockerLive = Layer.effect(
  Docker,
  Effect.gen(function* () {
    const sub = yield* Subprocess

    const mapErr = (op: string) => (e: { stderr: string }) =>
      new DockerError({ operation: op, message: e.stderr })

    return Docker.of({
      build: (opts) =>
        sub
          .runInteractive(
            "docker",
            [
              "build",
              "-f",
              opts.dockerfile,
              "-t",
              opts.tag,
              ...(opts.platform ? ["--platform", opts.platform] : []),
              ...(opts.cacheFrom ?? []).flatMap((c) => ["--cache-from", c]),
              ...(opts.inlineCache
                ? ["--build-arg", "BUILDKIT_INLINE_CACHE=1"]
                : []),
              // BuildKit's default `--progress=auto` falls silent when stderr
              // isn't a TTY (CI logs, captured background jobs, `2>&1 |`).
              // Force plain in those cases so each step is line-streamed; in
              // an interactive terminal keep auto for the live UI.
              ...(process.stderr.isTTY ? [] : ["--progress=plain"]),
              opts.contextDir,
            ],
            { env: { DOCKER_BUILDKIT: "1" } },
          )
          .pipe(Effect.mapError(mapErr("build"))),
      tag: (source, target) =>
        sub
          .run("docker", ["tag", source, target])
          .pipe(Effect.asVoid, Effect.mapError(mapErr("tag"))),
      push: (image) =>
        sub
          .runInteractive("docker", ["push", image])
          .pipe(Effect.mapError(mapErr("push"))),
      login: (registry, username, password) =>
        sub
          .run(
            "docker",
            ["login", "--username", username, "--password-stdin", registry],
            { stdin: password },
          )
          .pipe(Effect.asVoid, Effect.mapError(mapErr("login"))),
    })
  }),
)
