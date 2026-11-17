import { Effect, Layer } from "effect"
import { ImageRegistry } from "../../services/backend/ImageRegistry.ts"
import { Acr, acrLoginServer } from "../../adapters/azure/Acr.ts"
import { AzAuth } from "../../adapters/azure/AzAuth.ts"
import { Docker } from "../../adapters/Docker.ts"
import { ConfigService } from "../../services/ConfigService.ts"
import { AzureError } from "../../infra/Errors.ts"
import { makeResolveAzureCoords } from "./azureCoords.ts"

/**
 * Azure implementation of ImageRegistry, backed by the project's Azure
 * Container Registry. `repoName` from BuildService (`afk/<repo>`) is a nested
 * ACR repository, created on first push.
 */
export const AzureImageRegistryLive = Layer.effect(
  ImageRegistry,
  Effect.gen(function* () {
    const acr = yield* Acr
    const auth = yield* AzAuth
    const docker = yield* Docker
    const cfg = yield* ConfigService
    const resolve = makeResolveAzureCoords(cfg, auth)

    // ImageRegistry's error channel carries provider errors only, so a config
    // or subscription refusal is reported as the AzureError it amounts to.
    const registry = resolve.pipe(
      Effect.map((c) => c.names.registry),
      Effect.mapError((e) =>
        e._tag === "AzureError"
          ? e
          : new AzureError({
              operation: "config:resolveAzureCoords",
              message: e.message,
            }),
      ),
    )

    return ImageRegistry.of({
      registryUri: registry.pipe(Effect.map(acrLoginServer)),
      imageExists: (repoName, tag) =>
        registry.pipe(Effect.flatMap((r) => acr.imageExists(r, repoName, tag))),
      listLatestTagsByPrefix: (repoName, tagPrefix, limit) =>
        registry.pipe(
          Effect.flatMap((r) =>
            acr.listLatestTagsByPrefix(r, repoName, tagPrefix, limit),
          ),
        ),
      ensureRepoAndAuth: (_repoName) =>
        registry.pipe(Effect.flatMap(acr.login)),
      push: (imageUri) => docker.push(imageUri),
    })
  }),
)
