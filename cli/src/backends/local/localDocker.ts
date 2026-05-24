import { Effect } from "effect"
import { Subprocess } from "../../infra/Subprocess.ts"
import type { ParseError, SubprocessError } from "../../infra/Errors.ts"
import { LABEL_MANAGED } from "../../constants.ts"
import type { RunStatus } from "../../schema/Run.ts"

/**
 * One AFK-managed container as seen by the host Docker daemon — the Local
 * Backend's truth source, the analogue of an EC2 instance in
 * `ec2:DescribeInstances`. Both live Runs (`docker ps`) and recently-terminated
 * ones (`docker ps -a`, before pruning) are visible here, which is what lets
 * RunHistory reconcile terminal state lazily without a supervisor.
 */
export interface LocalContainer {
  readonly id: string
  readonly name: string
  readonly labels: Record<string, string>
  /** Native docker state: created | running | paused | restarting | removing | exited | dead. */
  readonly state: string
  readonly exitCode: number
  readonly startedAt: string
  readonly finishedAt: string
}

/** Raw shape of the `docker inspect` fields we read. */
interface InspectRecord {
  readonly Id: string
  readonly Name: string
  readonly State?: {
    readonly Status?: string
    readonly ExitCode?: number
    readonly StartedAt?: string
    readonly FinishedAt?: string
  }
  readonly Config?: { readonly Labels?: Record<string, string> | null }
}

/** Map a native docker container state onto the Backend-neutral RunStatus. */
export const mapDockerState = (state: string): RunStatus => {
  switch (state) {
    case "created":
    case "restarting":
      return "PROVISIONING"
    case "running":
    case "paused":
      return "RUNNING"
    case "removing":
      return "STOPPING"
    case "exited":
    case "dead":
    default:
      return "STOPPED"
  }
}

const ZERO_TIME = "0001-01-01T00:00:00Z"

/**
 * List every AFK-managed container (running + stopped) with the fields the
 * Local seams need. Returns an empty array when none exist; never assumes the
 * daemon has any AFK containers.
 */
export const listAfkContainers = (
  sub: typeof Subprocess.Service,
): Effect.Effect<ReadonlyArray<LocalContainer>, SubprocessError | ParseError> =>
  Effect.gen(function* () {
    const ids = (yield* sub.run("docker", [
      "ps",
      "-a",
      "--filter",
      `label=${LABEL_MANAGED}=true`,
      "--format",
      "{{.ID}}",
    ])).stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)

    if (ids.length === 0) return []

    const records = yield* sub.runJson<ReadonlyArray<InspectRecord>>("docker", [
      "inspect",
      ...ids,
    ])

    return records.map((r): LocalContainer => {
      const finishedAt = r.State?.FinishedAt ?? ""
      return {
        id: r.Id,
        name: (r.Name ?? "").replace(/^\//, ""),
        labels: r.Config?.Labels ?? {},
        state: r.State?.Status ?? "exited",
        exitCode: r.State?.ExitCode ?? 0,
        startedAt: r.State?.StartedAt ?? "",
        finishedAt: finishedAt === ZERO_TIME ? "" : finishedAt,
      }
    })
  })
