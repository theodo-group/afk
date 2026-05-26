import { DateTime, Effect, Layer } from "effect"
import {
  Firestore,
  bv,
  iv,
  readBv,
  readIv,
  readSv,
  sv,
  type Fields,
} from "../../adapters/gcp/Firestore.ts"
import { Auth } from "../../adapters/gcp/Auth.ts"
import { Gce } from "../../adapters/gcp/Gce.ts"
import { ConfigService } from "../../services/ConfigService.ts"
import {
  RunHistory,
  type HistoryRow,
} from "../../services/backend/RunHistory.ts"
import {
  GCP_DEFAULT_ZONE,
  GCP_LABEL_MANAGED,
  GCP_RUNS_COLLECTION,
} from "../../constants.ts"

const rowFromFields = (f: Fields): HistoryRow | null => {
  const runId = readSv(f, "run_id")
  if (!runId) return null
  const status = readSv(f, "status") ?? "running"
  return {
    runId,
    owner: readSv(f, "owner") ?? "",
    repo: readSv(f, "repo") ?? "",
    branch: readSv(f, "branch") ?? "",
    sha: readSv(f, "sha") ?? "",
    image: readSv(f, "image") ?? "",
    resourceId: readSv(f, "instance_name") ?? "",
    status: status === "running" ? "RUNNING" : "STOPPED",
    startedAt: readSv(f, "started_at") ?? "",
    stoppedAt: readSv(f, "stopped_at"),
    exitCode: readIv(f, "exit_code"),
    timeoutHours: readIv(f, "timeout_hours") ?? 0,
    backendDetails: {
      machineType: readSv(f, "machine_type") ?? "",
      zone: readSv(f, "zone") ?? "",
      spot: String(readBv(f, "spot") ?? false),
    },
  }
}

/**
 * GCP implementation of RunHistory. Backed by Firestore (Native mode), keyed by
 * `run_id`, with composite indexes on `owner+started_at` for `afk history`
 * queries (the Firestore analogue of the DynamoDB GSIs). Shared with the
 * reconcile Cloud Function; `query` also reconciles inline so the picker
 * doesn't show stale "running" rows in the 0-5 minute gap before the sweeper
 * fires (and as a backstop if the sweeper isn't deployed at all).
 */
export const GcpRunHistoryLive = Layer.effect(
  RunHistory,
  Effect.gen(function* () {
    const fs = yield* Firestore
    const auth = yield* Auth
    const cfg = yield* ConfigService
    const gce = yield* Gce

    const project = Effect.gen(function* () {
      const { config } = yield* cfg.load
      return config.gcp?.projectId ?? (yield* auth.activeProject)
    })

    const zone = cfg.load.pipe(
      Effect.map((r) => r.config.gcp?.zone ?? GCP_DEFAULT_ZONE),
    )

    return RunHistory.of({
      recordStart: (input) =>
        Effect.gen(function* () {
          const p = yield* project
          const fields: Fields = {
            run_id: sv(input.runId),
            status: sv("running"),
            owner: sv(input.owner),
            repo: sv(input.repo),
            branch: sv(input.branch),
            sha: sv(input.sha),
            image: sv(input.image),
            instance_name: sv(input.resourceId),
            machine_type: sv(input.backendDetails?.machineType ?? ""),
            zone: sv(input.backendDetails?.zone ?? ""),
            started_at: sv(input.startedAt),
            timeout_hours: iv(input.timeoutHours),
            spot: bv(input.backendDetails?.spot === "true"),
          }
          yield* fs.putDoc({
            project: p,
            collection: GCP_RUNS_COLLECTION,
            docId: input.runId,
            fields,
          })
        }),

      recordComplete: ({ runId, stoppedAt, exitCode }) =>
        Effect.gen(function* () {
          const p = yield* project
          const existing = yield* fs.getDoc({
            project: p,
            collection: GCP_RUNS_COLLECTION,
            docId: runId,
          })
          if (!existing) return
          const fields: Fields = {
            ...existing,
            status: sv(exitCode === 0 ? "stopped" : "failed"),
            stopped_at: sv(stoppedAt),
            ...(exitCode !== undefined ? { exit_code: iv(exitCode) } : {}),
          }
          yield* fs.putDoc({
            project: p,
            collection: GCP_RUNS_COLLECTION,
            docId: runId,
            fields,
          })
        }),

      query: ({ since, owner, branch, limit }) =>
        Effect.gen(function* () {
          const p = yield* project
          const sinceIsoUtc = since ? DateTime.formatIso(since) : undefined
          const filters = [
            ...(owner
              ? [
                  {
                    field: "owner",
                    op: "EQUAL" as const,
                    value: sv(owner),
                  },
                ]
              : []),
            ...(sinceIsoUtc
              ? [
                  {
                    field: "started_at",
                    op: "GREATER_THAN_OR_EQUAL" as const,
                    value: sv(sinceIsoUtc),
                  },
                ]
              : []),
          ]
          const docs = yield* fs.queryDocs({
            project: p,
            collection: GCP_RUNS_COLLECTION,
            filters,
            orderByField: "started_at",
            descending: true,
            ...(limit !== undefined ? { limit } : {}),
          })

          const runningDocs = docs.filter(
            (d) => readSv(d, "status") === "running",
          )
          // Lazy reconcile — same pattern as LocalRunHistory.query. List live
          // afk-managed VMs in the configured zone; any "running" row whose
          // instance isn't there has actually ended, so flip it (best-effort
          // Firestore write, mirroring the sweeper Cloud Function's transition).
          // Best-effort: a failed listInstances or putDoc just means the picker
          // shows what Firestore had, no harder than today.
          if (runningDocs.length > 0) {
            const z = yield* zone
            const liveNames = yield* gce
              .listInstances({
                project: p,
                zone: z,
                labelFilters: [{ key: GCP_LABEL_MANAGED, value: "true" }],
              })
              .pipe(
                Effect.map(
                  (instances) => new Set(instances.map((i) => i.name)),
                ),
                Effect.catchAll(() => Effect.succeed(new Set<string>())),
              )
            const stoppedAt = DateTime.formatIso(yield* DateTime.now)
            const reconciled = runningDocs
              .map((d) => ({ d, name: readSv(d, "instance_name") ?? "" }))
              .filter(({ name }) => name !== "" && !liveNames.has(name))
            yield* Effect.forEach(
              reconciled,
              ({ d }) => {
                const runId = readSv(d, "run_id")
                if (!runId) return Effect.void
                const next: Fields = {
                  ...d,
                  status: sv("stopped"),
                  stopped_at: sv(stoppedAt),
                  stop_reason: sv("reconcile: instance no longer exists"),
                }
                // Mutate the source doc too so the rowFromFields below sees
                // the flipped status without an extra refetch.
                ;(d as Record<string, unknown>).status = sv("stopped")
                ;(d as Record<string, unknown>).stopped_at = sv(stoppedAt)
                ;(d as Record<string, unknown>).stop_reason = sv(
                  "reconcile: instance no longer exists",
                )
                return fs
                  .putDoc({
                    project: p,
                    collection: GCP_RUNS_COLLECTION,
                    docId: runId,
                    fields: next,
                  })
                  .pipe(Effect.catchAll(() => Effect.void))
              },
              { concurrency: "unbounded" },
            )
          }

          return docs
            .map(rowFromFields)
            .filter((x): x is HistoryRow => x !== null)
            .filter((row) => !branch || row.branch === branch)
        }),
    })
  }),
)
