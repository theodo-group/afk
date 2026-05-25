import { Context, Effect, Layer } from "effect"
import { Subprocess } from "../../infra/Subprocess.ts"
import { GcpError } from "../../infra/Errors.ts"
import { makeGcloudCli } from "./gcloudCli.ts"

/**
 * Artifact Registry adapter — the GCP analogue of `Ecr`. A single regional
 * Docker repository (`<region>-docker.pkg.dev/<project>/<repo>`) holds every
 * per-build agent image. `gcloud auth configure-docker <host>` wires the local
 * Docker daemon to push via the active gcloud credentials.
 */
export class ArtifactRegistry extends Context.Tag("ArtifactRegistry")<
  ArtifactRegistry,
  {
    /** Registry URI prefix, e.g. "us-central1-docker.pkg.dev/<project>/afk". */
    readonly registryUri: (
      project: string,
      region: string,
      repo: string,
    ) => Effect.Effect<string, GcpError>
    readonly imageExists: (
      project: string,
      region: string,
      repo: string,
      image: string,
      tag: string,
    ) => Effect.Effect<boolean, GcpError>
    readonly listLatestTagsByPrefix: (
      project: string,
      region: string,
      repo: string,
      image: string,
      tagPrefix: string,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<string>, GcpError>
    /** Ensure the repo exists (idempotent) and configure-docker for its host. */
    readonly ensureRepoAndAuth: (
      project: string,
      region: string,
      repo: string,
    ) => Effect.Effect<void, GcpError>
  }
>() {}

const host = (region: string): string => `${region}-docker.pkg.dev`

export const ArtifactRegistryLive = Layer.effect(
  ArtifactRegistry,
  Effect.gen(function* () {
    const sub = yield* Subprocess
    const gcloud = makeGcloudCli(sub)

    const registryUri = (project: string, region: string, repo: string) =>
      Effect.succeed(`${host(region)}/${project}/${repo}`)

    const imageExists = (
      project: string,
      region: string,
      repo: string,
      image: string,
      tag: string,
    ) =>
      gcloud.exists([
        "artifacts",
        "docker",
        "tags",
        "describe",
        `${host(region)}/${project}/${repo}/${image}:${tag}`,
      ])

    const listLatestTagsByPrefix = (
      project: string,
      region: string,
      repo: string,
      image: string,
      tagPrefix: string,
      limit: number,
    ) =>
      gcloud
        .json<
          ReadonlyArray<{
            tags?: string | ReadonlyArray<string>
            createTime?: string
          }>
        >("artifacts:docker:images:list", [
          "artifacts",
          "docker",
          "images",
          "list",
          `${host(region)}/${project}/${repo}/${image}`,
          "--include-tags",
        ])
        .pipe(
          Effect.map((rows) =>
            rows
              .flatMap((r) => {
                // gcloud returns `tags` either as a comma-string (older
                // versions / `--format=value`) or as an array (newer JSON
                // output). Accept both.
                if (Array.isArray(r.tags)) return [...r.tags]
                if (typeof r.tags === "string") return r.tags.split(",")
                return []
              })
              .map((t) => t.trim())
              .filter((t) => t.startsWith(tagPrefix))
              .slice(0, limit),
          ),
          // Repo may not exist yet on first build; that's fine.
          Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<string>)),
        )

    const ensureRepoAndAuth = (project: string, region: string, repo: string) =>
      Effect.gen(function* () {
        const exists = yield* gcloud.exists([
          "artifacts",
          "repositories",
          "describe",
          repo,
          `--project=${project}`,
          `--location=${region}`,
        ])
        if (!exists) {
          yield* gcloud.run("artifacts:repositories:create", [
            "artifacts",
            "repositories",
            "create",
            repo,
            `--project=${project}`,
            `--location=${region}`,
            "--repository-format=docker",
          ])
        }
        yield* gcloud.run("auth:configure-docker", [
          "auth",
          "configure-docker",
          host(region),
          "--quiet",
        ])
      })

    return ArtifactRegistry.of({
      registryUri,
      imageExists,
      listLatestTagsByPrefix,
      ensureRepoAndAuth,
    })
  }),
)
