import { DateTime, Effect, Layer } from "effect"
import {
  AzStorage,
  RUNS_PARTITION,
  type TableEntity,
} from "../../adapters/azure/AzStorage.ts"
import { AzAuth } from "../../adapters/azure/AzAuth.ts"
import { AzVm } from "../../adapters/azure/AzVm.ts"
import { ConfigService } from "../../services/ConfigService.ts"
import {
  RunHistory,
  type HistoryRow,
  type QueryInput,
} from "../../services/backend/RunHistory.ts"
import { AZURE_RUNS_TABLE, AZURE_TAG_MANAGED } from "../../constants.ts"
import { makeResolveAzureCoords } from "./azureCoords.ts"

const RECONCILE_REASON = "reconcile: VM no longer exists"

/** An OData string literal: single quotes doubled. */
const odata = (v: string): string => `'${v.replace(/'/g, "''")}'`

/** The `$filter` for a history query; undefined for "everything". Pure. */
export const historyFilter = (
  q: Pick<QueryInput, "owner" | "since">,
): string | undefined => {
  const clauses = [
    `PartitionKey eq ${odata(RUNS_PARTITION)}`,
    ...(q.owner ? [`owner eq ${odata(q.owner)}`] : []),
    ...(q.since ? [`started_at ge ${odata(DateTime.formatIso(q.since))}`] : []),
  ]
  return clauses.join(" and ")
}

const intOf = (v: string | undefined): number | undefined => {
  if (v === undefined || v === "") return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/** The neutral row a Table entity maps to, or null for a foreign entity. Pure. */
export const rowFromEntity = (e: TableEntity): HistoryRow | null => {
  const runId = e.run_id ?? e.RowKey
  if (!runId) return null
  return {
    runId,
    owner: e.owner ?? "",
    ...(e.submitted_by ? { submittedBy: e.submitted_by } : {}),
    repo: e.repo ?? "",
    branch: e.branch ?? "",
    sha: e.sha ?? "",
    image: e.image ?? "",
    resourceId: e.vm_name ?? "",
    status: (e.status ?? "running") === "running" ? "RUNNING" : "STOPPED",
    startedAt: e.started_at ?? "",
    stoppedAt: e.stopped_at,
    exitCode: intOf(e.exit_code),
    timeoutHours: intOf(e.timeout_hours) ?? 0,
    backendDetails: {
      vmSize: e.vm_size ?? "",
      location: e.location ?? "",
      spot: e.spot ?? "false",
    },
  }
}

/**
 * Azure implementation of RunHistory, on a Table Storage table keyed by run id
 * in a single partition — the DynamoDB / Firestore analogue, shared with the
 * sweeper Function and written by each Run's VM on exit. `query` also
 * reconciles inline, so the picker does not show stale "running" rows in the
 * gap before the sweeper fires (or when it is not deployed at all).
 */
export const AzureRunHistoryLive = Layer.effect(
  RunHistory,
  Effect.gen(function* () {
    const storage = yield* AzStorage
    const vms = yield* AzVm
    const auth = yield* AzAuth
    const cfg = yield* ConfigService
    const coords = makeResolveAzureCoords(cfg, auth)

    const table = coords.pipe(
      Effect.map((c) => ({
        account: c.names.storageAccount,
        resourceGroup: c.resourceGroup,
      })),
    )

    return RunHistory.of({
      recordStart: (input) =>
        table.pipe(
          Effect.flatMap(({ account }) =>
            storage.upsertEntity(account, AZURE_RUNS_TABLE, {
              PartitionKey: RUNS_PARTITION,
              RowKey: input.runId,
              run_id: input.runId,
              status: "running",
              owner: input.owner,
              submitted_by: input.submittedBy ?? input.owner,
              repo: input.repo,
              branch: input.branch,
              sha: input.sha,
              image: input.image,
              vm_name: input.resourceId,
              vm_size: input.backendDetails?.vmSize ?? "",
              location: input.backendDetails?.location ?? "",
              started_at: input.startedAt,
              timeout_hours: String(input.timeoutHours),
              spot: input.backendDetails?.spot ?? "false",
            }),
          ),
        ),

      recordComplete: ({ runId, stoppedAt, exitCode }) =>
        table.pipe(
          Effect.flatMap(({ account }) =>
            storage.mergeEntity(account, AZURE_RUNS_TABLE, {
              PartitionKey: RUNS_PARTITION,
              RowKey: runId,
              status: exitCode === 0 ? "stopped" : "failed",
              stopped_at: stoppedAt,
              ...(exitCode !== undefined
                ? { exit_code: String(exitCode) }
                : {}),
            }),
          ),
        ),

      query: ({ since, owner, branch, limit }) =>
        Effect.gen(function* () {
          const { account, resourceGroup } = yield* table
          const entities = yield* storage.queryEntities(
            account,
            AZURE_RUNS_TABLE,
            historyFilter({ owner, since }),
          )
          const sorted = [...entities]
            .sort((a, b) =>
              (a.started_at ?? "") < (b.started_at ?? "") ? 1 : -1,
            )
            .slice(0, limit ?? entities.length)

          // Lazy reconcile — a "running" row whose VM is gone has ended. The
          // write is best-effort; a failure only means the picker shows what
          // the table had.
          const running = sorted.filter((e) => e.status === "running")
          const live =
            running.length === 0
              ? new Set<string>()
              : yield* vms
                  .listVms(resourceGroup, { [AZURE_TAG_MANAGED]: "true" })
                  .pipe(
                    Effect.map((found) => new Set(found.map((v) => v.name))),
                    Effect.catchAll(() => Effect.succeed(new Set<string>())),
                  )
          const stoppedAt = DateTime.formatIso(yield* DateTime.now)
          const orphaned = new Set(
            running
              .filter(
                (e) => (e.vm_name ?? "") !== "" && !live.has(e.vm_name ?? ""),
              )
              .map((e) => e.RowKey ?? ""),
          )
          yield* Effect.forEach(
            [...orphaned],
            (rowKey) =>
              storage
                .mergeEntity(account, AZURE_RUNS_TABLE, {
                  PartitionKey: RUNS_PARTITION,
                  RowKey: rowKey,
                  status: "stopped",
                  stopped_at: stoppedAt,
                  stop_reason: RECONCILE_REASON,
                })
                .pipe(Effect.catchAll(() => Effect.void)),
            { concurrency: "unbounded" },
          )

          return sorted
            .map((e) =>
              orphaned.has(e.RowKey ?? "")
                ? { ...e, status: "stopped", stopped_at: stoppedAt }
                : e,
            )
            .map(rowFromEntity)
            .filter((r): r is HistoryRow => r !== null)
            .filter((r) => !branch || r.branch === branch)
        }),
    })
  }),
)
