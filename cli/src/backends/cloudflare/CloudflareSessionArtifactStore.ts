import { Effect, Layer } from "effect"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { SessionArtifactStore } from "../../services/backend/SessionArtifactStore.ts"
import { retrieveFromCollectedDir } from "../../services/SessionArtifactFs.ts"
import { Subprocess } from "../../infra/Subprocess.ts"
import { CfWorker } from "./CfWorker.ts"
import { UserError } from "../../infra/Errors.ts"

/**
 * Cloudflare implementation of SessionArtifactStore.
 *
 * The golden bootstrap tars the collected base dirs and POSTs them (base64) to
 * the launcher Worker, which stores the gzipped tar in R2. Retrieval is the
 * mirror: GET `/runs/:id/session-artifact` (CF-Access-authed), base64-decode the
 * tarball to a temp file, extract it, and hand the tree to the shared
 * `retrieveFromCollectedDir` for the precise glob + size cap. An empty response
 * (`{}`) means no artifact was collected for the Run.
 */
export const CloudflareSessionArtifactStoreLive = Layer.effect(
  SessionArtifactStore,
  Effect.gen(function* () {
    const worker = yield* CfWorker
    const sub = yield* Subprocess

    return SessionArtifactStore.of({
      fetch: (input) =>
        Effect.gen(function* () {
          const path = `/runs/${encodeURIComponent(input.runId)}/session-artifact`
          const { tarGzB64 } = yield* worker.getJson<{ tarGzB64?: string }>(
            "GET /runs/:id/session-artifact",
            path,
          )
          if (!tarGzB64) return { written: [], skipped: [] }

          // Stage the tarball and an empty extract dir (a sibling, so the
          // tarball itself isn't walked by the retriever).
          const { tarPath, extracted } = yield* Effect.try({
            try: () => {
              const dir = mkdtempSync(resolve(tmpdir(), "afk-artifact-"))
              const tarPath = resolve(dir, "artifacts.tar.gz")
              writeFileSync(tarPath, Buffer.from(tarGzB64, "base64"))
              const extracted = resolve(dir, "extracted")
              mkdirSync(extracted)
              return { tarPath, extracted }
            },
            catch: (cause) =>
              new UserError({
                message: `could not stage session artifact: ${String(cause)}`,
              }),
          })

          yield* sub.run("tar", ["xzf", tarPath, "-C", extracted]).pipe(
            Effect.mapError(
              (e) =>
                new UserError({
                  message: `could not extract session artifact: ${e.stderr || String(e)}`,
                }),
            ),
          )

          return yield* Effect.try({
            try: () =>
              retrieveFromCollectedDir(extracted, input.patterns, input.outDir),
            catch: (cause) =>
              new UserError({
                message: `could not retrieve session artifact: ${String(cause)}`,
              }),
          })
        }),
    })
  }),
)
