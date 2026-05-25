import { Context, Effect } from "effect"
import {
  AwsError,
  CloudflareError,
  GcpError,
  ConfigError,
  UserError,
} from "../../infra/Errors.ts"

export interface FetchInput {
  readonly runId: string
  readonly repoName: string
  /**
   * The developer's declared `sessionArtifacts` globs (absolute container
   * paths). The store applies them — via `selectArtifacts` — against whatever
   * was collected, so retrieval reflects the current config even though the
   * coarse base dirs were what got copied at Run end.
   */
  readonly patterns: ReadonlyArray<string>
  /** Local directory to write the retrieved file(s) into. */
  readonly outDir: string
}

export interface FetchResult {
  /** Absolute local paths written under `outDir`. */
  readonly written: ReadonlyArray<string>
  /** Container-side paths that matched but were skipped for exceeding the cap. */
  readonly skipped: ReadonlyArray<string>
}

/**
 * Backend-neutral retrieval of a Run's Session Artifact(s) (see CONTEXT.md).
 * The collection side is wired into each Backend's Run orchestrator (it copies
 * the declared base dirs out of the main service at graceful exit); this seam
 * is only the read side, the analogue of `LogStore.tail` for a one-shot blob
 * rather than a stream.
 *
 * Local reads the files off the per-Run scratch dir; the cloud Backends read
 * from their per-Run storage prefix (AWS S3, CF R2).
 */
export class SessionArtifactStore extends Context.Tag("SessionArtifactStore")<
  SessionArtifactStore,
  {
    readonly fetch: (
      input: FetchInput,
    ) => Effect.Effect<
      FetchResult,
      AwsError | CloudflareError | GcpError | ConfigError | UserError
    >
  }
>() {}
