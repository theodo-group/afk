import { Effect, Layer } from "effect"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { SessionArtifactStore } from "../../services/backend/SessionArtifactStore.ts"
import { retrieveFromCollectedDir } from "../../services/SessionArtifactFs.ts"
import { Gcs } from "../../adapters/gcp/Gcs.ts"
import { Auth } from "../../adapters/gcp/Auth.ts"
import { ConfigService } from "../../services/ConfigService.ts"
import { UserError } from "../../infra/Errors.ts"
import {
  GCP_ARTIFACTS_BUCKET_PREFIX,
  SESSION_ARTIFACT_DIR,
} from "../../constants.ts"

/**
 * GCP implementation of SessionArtifactStore.
 *
 * The Run uploads the collected base dirs to `gs://<artifacts-bucket>/<repo>/
 * <runId>/session-artifacts/` before self-deleting (see the startup-script).
 * Retrieval syncs that prefix to a temp dir and hands it to the shared
 * `retrieveFromCollectedDir`, which applies the precise globs + size cap. The
 * bucket name is derived from the project id, so no Terraform output read is
 * needed.
 */
export const GcpSessionArtifactStoreLive = Layer.effect(
  SessionArtifactStore,
  Effect.gen(function* () {
    const gcs = yield* Gcs
    const auth = yield* Auth
    const cfg = yield* ConfigService

    return SessionArtifactStore.of({
      fetch: (input) =>
        Effect.gen(function* () {
          const { config } = yield* cfg.load
          const project = config.gcp?.projectId ?? (yield* auth.activeProject)
          const bucket = `${GCP_ARTIFACTS_BUCKET_PREFIX}-${project}`
          const prefix = `${input.repoName}/${input.runId}/${SESSION_ARTIFACT_DIR}/`

          const stage = yield* Effect.try({
            try: () => mkdtempSync(resolve(tmpdir(), "afk-artifact-")),
            catch: (cause) =>
              new UserError({
                message: `could not create staging dir: ${String(cause)}`,
              }),
          })

          yield* gcs.downloadPrefix({ bucket, prefix, destDir: stage })

          return yield* Effect.try({
            try: () =>
              retrieveFromCollectedDir(stage, input.patterns, input.outDir),
            catch: (cause) =>
              new UserError({
                message: `could not retrieve session artifact: ${String(cause)}`,
              }),
          })
        }),
    })
  }),
)
