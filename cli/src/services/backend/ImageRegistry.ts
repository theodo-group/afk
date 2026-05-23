import { Context, Effect } from "effect"
import { AwsError, DockerError } from "../../infra/Errors.ts"

/**
 * Backend-neutral wrapper-image registry.
 *
 * Owns registry-side concerns only (URI construction, existence checks, tag
 * listing for cache-from, login + push). The docker build itself is performed
 * by `BuildService` and is Backend-neutral. The Backend's Compute layer
 * receives the resolved `imageUri` and passes it to its compute primitive.
 */
export class ImageRegistry extends Context.Tag("ImageRegistry")<
  ImageRegistry,
  {
    /** Registry host, e.g. "<account>.dkr.ecr.eu-west-1.amazonaws.com". */
    readonly registryUri: Effect.Effect<string, AwsError>

    /** True if `<repo>:<tag>` already exists in the registry. */
    readonly imageExists: (
      repoName: string,
      tag: string,
    ) => Effect.Effect<boolean, AwsError>

    /**
     * Newest tags matching `<repo>:<tagPrefix>*`. Used by BuildService for
     * BuildKit `--cache-from`. Returns an empty array if the repo doesn't
     * exist or has no matching tags.
     */
    readonly listLatestTagsByPrefix: (
      repoName: string,
      tagPrefix: string,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<string>, AwsError>

    /**
     * Ensure the named repo exists (idempotent) and the local docker daemon
     * is authenticated to push to it.
     */
    readonly ensureRepoAndAuth: (
      repoName: string,
    ) => Effect.Effect<void, AwsError | DockerError>

    /**
     * Push an already-built local image (whose tag is `imageUri`) to the
     * registry. The caller is responsible for having tagged the image as
     * `imageUri` before calling this.
     */
    readonly push: (
      imageUri: string,
    ) => Effect.Effect<void, AwsError | DockerError>
  }
>() {}
