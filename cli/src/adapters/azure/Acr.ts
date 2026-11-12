import { Context, Effect, Layer } from "effect"
import { Subprocess } from "../../infra/Subprocess.ts"
import { AzureError } from "../../infra/Errors.ts"
import { makeAzCli } from "./azCli.ts"

/** An ACR registry's login server — the host part of every image URI in it. */
export const acrLoginServer = (registry: string): string =>
  `${registry.toLowerCase()}.azurecr.io`

/**
 * Azure Container Registry adapter — the analogue of `Ecr` / `ArtifactRegistry`.
 * ACR creates a repository on first push, so there is nothing to ensure but the
 * local Docker daemon's login.
 */
export class Acr extends Context.Tag("Acr")<
  Acr,
  {
    readonly imageExists: (
      registry: string,
      repository: string,
      tag: string,
    ) => Effect.Effect<boolean>
    /** Newest-first tags of `repository` starting with `tagPrefix`; [] if none. */
    readonly listLatestTagsByPrefix: (
      registry: string,
      repository: string,
      tagPrefix: string,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<string>>
    /** `az acr login`: hands the local Docker daemon a short-lived token. */
    readonly login: (registry: string) => Effect.Effect<void, AzureError>
  }
>() {}

// ACR pages `show-tags`; a build's cache-from only needs the newest few, so one
// generous page sorted newest-first is enough.
const TAG_PAGE = 100

export const AcrLive = Layer.effect(
  Acr,
  Effect.gen(function* () {
    const sub = yield* Subprocess
    const az = makeAzCli(sub)

    const imageExists = (registry: string, repository: string, tag: string) =>
      az.exists([
        "acr",
        "repository",
        "show",
        "--name",
        registry,
        "--image",
        `${repository}:${tag}`,
      ])

    const listLatestTagsByPrefix = (
      registry: string,
      repository: string,
      tagPrefix: string,
      limit: number,
    ) =>
      az
        .json<ReadonlyArray<string>>("acr:repository:show-tags", [
          "acr",
          "repository",
          "show-tags",
          "--name",
          registry,
          "--repository",
          repository,
          "--orderby",
          "time_desc",
          "--top",
          String(TAG_PAGE),
        ])
        .pipe(
          Effect.map((tags) =>
            tags.filter((t) => t.startsWith(tagPrefix)).slice(0, limit),
          ),
          Effect.catchAll(() => Effect.succeed<ReadonlyArray<string>>([])),
        )

    const login = (registry: string) =>
      az.run("acr:login", ["acr", "login", "--name", registry])

    return Acr.of({ imageExists, listLatestTagsByPrefix, login })
  }),
)
