import { Context, Effect, Layer } from "effect"
import { Subprocess } from "../../infra/Subprocess.ts"
import { GcpError } from "../../infra/Errors.ts"
import { makeGcloudCli } from "./gcloudCli.ts"

/**
 * Cloud Storage adapter — the GCP analogue of `S3`. Used to retrieve Session
 * Artifacts the Run uploaded before self-deleting. `gcloud storage cp` is a
 * no-op (not an error) when the prefix holds no objects — the natural "no
 * Session Artifact for this Run" case.
 */
export class Gcs extends Context.Tag("Gcs")<
  Gcs,
  {
    readonly downloadPrefix: (input: {
      readonly bucket: string
      readonly prefix: string
      readonly destDir: string
    }) => Effect.Effect<void, GcpError>
  }
>() {}

export const GcsLive = Layer.effect(
  Gcs,
  Effect.gen(function* () {
    const sub = yield* Subprocess
    const gcloud = makeGcloudCli(sub)

    return Gcs.of({
      downloadPrefix: ({ bucket, prefix, destDir }) =>
        gcloud
          .run("storage:cp", [
            "storage",
            "cp",
            "--recursive",
            `gs://${bucket}/${prefix}*`,
            destDir,
          ])
          // An empty prefix yields "no URLs matched" — not an error here.
          .pipe(
            Effect.catchAll((e) =>
              e.message.includes("matched no") ||
              e.message.includes("No URLs matched")
                ? Effect.void
                : Effect.fail(e),
            ),
          ),
    })
  }),
)
