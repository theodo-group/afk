import { Context, type DateTime, Effect } from "effect"
import {
  AwsError,
  CloudflareError,
  GcpError,
  ConfigError,
  UserError,
} from "../../infra/Errors.ts"

/**
 * One row in the Backend-neutral history table. Stored at Run start by the
 * active Backend's Compute; updated to STOPPED+exitCode by the Backend's
 * lifecycle layer (sweeper Lambda on AWS, DO alarm on Cloudflare).
 */
export interface HistoryRow {
  readonly runId: string
  readonly owner: string
  readonly repo: string
  readonly branch: string
  readonly sha: string
  readonly image: string
  readonly resourceId: string
  readonly status: "RUNNING" | "STOPPED"
  readonly startedAt: string
  readonly stoppedAt?: string
  readonly exitCode?: number
  readonly timeoutHours: number
  readonly backendDetails?: Record<string, string>
}

export interface QueryInput {
  /** Lower bound on a Run's start: only Runs started at or after this instant. */
  readonly since?: DateTime.Utc
  readonly owner?: string
  readonly branch?: string
  readonly limit?: number
}

export interface RecordStartInput {
  readonly runId: string
  readonly owner: string
  readonly repo: string
  readonly branch: string
  readonly sha: string
  readonly image: string
  readonly resourceId: string
  readonly startedAt: string
  readonly timeoutHours: number
  readonly backendDetails?: Record<string, string>
}

export interface RecordCompleteInput {
  readonly runId: string
  readonly stoppedAt: string
  readonly exitCode?: number
}

export class RunHistory extends Context.Tag("RunHistory")<
  RunHistory,
  {
    readonly recordStart: (
      input: RecordStartInput,
    ) => Effect.Effect<
      void,
      AwsError | CloudflareError | GcpError | ConfigError | UserError
    >

    readonly recordComplete: (
      input: RecordCompleteInput,
    ) => Effect.Effect<
      void,
      AwsError | CloudflareError | GcpError | ConfigError | UserError
    >

    readonly query: (
      input: QueryInput,
    ) => Effect.Effect<
      ReadonlyArray<HistoryRow>,
      AwsError | CloudflareError | GcpError | ConfigError | UserError
    >
  }
>() {}
