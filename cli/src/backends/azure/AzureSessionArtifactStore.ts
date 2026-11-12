import { Effect, Layer } from "effect"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { SessionArtifactStore } from "../../services/backend/SessionArtifactStore.ts"
import { retrieveFromCollectedDir } from "../../services/SessionArtifactFs.ts"
import { AzStorage } from "../../adapters/azure/AzStorage.ts"
import { AzAuth } from "../../adapters/azure/AzAuth.ts"
import { ConfigService } from "../../services/ConfigService.ts"
import { UserError } from "../../infra/Errors.ts"
import {
  AZURE_ARTIFACTS_CONTAINER,
  SESSION_ARTIFACT_DIR,
} from "../../constants.ts"
import { makeResolveAzureCoords } from "./azureCoords.ts"

/**
 * Azure implementation of SessionArtifactStore. The Run uploads the collected
 * base dirs to `afk-artifacts/<repo>/<runId>/session-artifacts/` before it
 * reclaims itself; retrieval downloads that prefix — `download-batch` keeps the
 * full blob names, so the collected tree sits under the prefix in the staging
 * dir — and hands it to the shared `retrieveFromCollectedDir`.
 */
export const AzureSessionArtifactStoreLive = Layer.effect(
  SessionArtifactStore,
  Effect.gen(function* () {
    const storage = yield* AzStorage
    const auth = yield* AzAuth
    const cfg = yield* ConfigService
    const coords = makeResolveAzureCoords(cfg, auth)

    return SessionArtifactStore.of({
      fetch: (input) =>
        Effect.gen(function* () {
          const { names } = yield* coords
          const prefix = `${input.repoName}/${input.runId}/${SESSION_ARTIFACT_DIR}/`
          const stage = yield* Effect.try({
            try: () => mkdtempSync(resolve(tmpdir(), "afk-artifact-")),
            catch: (cause) =>
              new UserError({
                message: `could not create staging dir: ${String(cause)}`,
              }),
          })
          yield* storage.downloadPrefix({
            account: names.storageAccount,
            container: AZURE_ARTIFACTS_CONTAINER,
            prefix,
            destDir: stage,
          })
          return yield* Effect.try({
            try: () =>
              retrieveFromCollectedDir(
                resolve(stage, prefix),
                input.patterns,
                input.outDir,
              ),
            catch: (cause) =>
              new UserError({
                message: `could not retrieve session artifact: ${String(cause)}`,
              }),
          })
        }),
    })
  }),
)
