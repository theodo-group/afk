import { Effect, Layer } from "effect"
import { SessionArtifactStore } from "../../services/backend/SessionArtifactStore.ts"
import { retrieveFromCollectedDir } from "../../services/SessionArtifactFs.ts"
import { UserError } from "../../infra/Errors.ts"
import { runSessionArtifactsDir } from "./localPaths.ts"

/**
 * Local implementation of SessionArtifactStore.
 *
 * The Run's bootstrap copies the declared base dirs onto the bind-mounted
 * scratch dir (`~/.afk/runs/<id>/session-artifacts/`), mirroring the container's
 * absolute layout. So retrieval is a host-side read off disk — no daemon
 * round-trip, the same shape as `LocalLogStore` reading logs straight off the
 * mount. The walk + glob + cap is the shared `retrieveFromCollectedDir`.
 */
export const LocalSessionArtifactStoreLive = Layer.succeed(
  SessionArtifactStore,
  SessionArtifactStore.of({
    fetch: (input) =>
      Effect.try({
        try: () =>
          retrieveFromCollectedDir(
            runSessionArtifactsDir(input.runId),
            input.patterns,
            input.outDir,
          ),
        catch: (cause) =>
          new UserError({
            message: `local: could not retrieve session artifact: ${String(cause)}`,
          }),
      }),
  }),
)
