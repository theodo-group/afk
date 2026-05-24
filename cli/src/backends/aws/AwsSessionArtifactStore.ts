import { Effect, Layer } from "effect"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { SessionArtifactStore } from "../../services/backend/SessionArtifactStore.ts"
import { retrieveFromCollectedDir } from "../../services/SessionArtifactFs.ts"
import { S3 } from "../../adapters/aws/S3.ts"
import { Sts } from "../../adapters/aws/Sts.ts"
import { ConfigService } from "../../services/ConfigService.ts"
import { UserError } from "../../infra/Errors.ts"
import {
  AFK_ARTIFACTS_BUCKET_PREFIX,
  DEFAULT_REGION,
  SESSION_ARTIFACT_DIR,
} from "../../constants.ts"

/**
 * AWS implementation of SessionArtifactStore.
 *
 * The Run VM ships the collected base dirs to `s3://<artifacts-bucket>/<repo>/
 * <runId>/session-artifacts/` before self-terminating (see UserData). Retrieval
 * syncs that prefix to a temp dir and hands it to the shared
 * `retrieveFromCollectedDir`, which applies the precise globs + size cap. The
 * bucket name is derived the same way as the state bucket, so no Terraform
 * output read is needed.
 */
export const AwsSessionArtifactStoreLive = Layer.effect(
  SessionArtifactStore,
  Effect.gen(function* () {
    const s3 = yield* S3
    const sts = yield* Sts
    const cfg = yield* ConfigService

    return SessionArtifactStore.of({
      fetch: (input) =>
        Effect.gen(function* () {
          const { config } = yield* cfg.load
          const region = config.aws?.region ?? DEFAULT_REGION
          const identity = yield* sts.callerIdentity
          const bucket = `${AFK_ARTIFACTS_BUCKET_PREFIX}-${identity.Account}-${region}`
          const prefix = `${input.repoName}/${input.runId}/${SESSION_ARTIFACT_DIR}/`

          const stage = yield* Effect.try({
            try: () => mkdtempSync(resolve(tmpdir(), "afk-artifact-")),
            catch: (cause) =>
              new UserError({
                message: `could not create staging dir: ${String(cause)}`,
              }),
          })

          yield* s3.downloadPrefix({ bucket, prefix, destDir: stage, region })

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
