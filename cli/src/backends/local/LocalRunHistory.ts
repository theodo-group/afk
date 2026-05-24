import { DateTime, Effect, Layer } from "effect"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { Subprocess } from "../../infra/Subprocess.ts"
import {
  RunHistory,
  type HistoryRow,
} from "../../services/backend/RunHistory.ts"
import { afkHome, historyFile } from "./localPaths.ts"
import {
  listAfkContainers,
  mapDockerState,
  type LocalContainer,
} from "./localDocker.ts"
import {
  LABEL_BRANCH,
  LABEL_IMAGE,
  LABEL_MAIN_SERVICE,
  LABEL_OWNER,
  LABEL_REPO,
  LABEL_RUN_ID,
  LABEL_SHA,
  LABEL_STARTED_AT,
  LABEL_TIMEOUT_HOURS,
  LOCAL_OWNER_ID,
} from "../../constants.ts"

/**
 * Local implementation of RunHistory.
 *
 * With no supervisor to write a row at exit (decision: lazy reconciliation),
 * the daemon is authoritative for any container that still exists and the
 * `~/.afk/history.jsonl` file is the durable archive for ones already pruned.
 * Every `query` reconciles: it folds the current afk-labeled containers over
 * the persisted rows, rewrites the file, then answers. This is what makes
 * `afk history` survive `docker system prune` while needing nothing running.
 */

const readArchive = (): Map<string, HistoryRow> => {
  const path = historyFile()
  const map = new Map<string, HistoryRow>()
  if (!existsSync(path)) return map
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const row = JSON.parse(trimmed) as HistoryRow
      map.set(row.runId, row)
    } catch {
      /* skip malformed line */
    }
  }
  return map
}

const writeArchive = (map: Map<string, HistoryRow>): void => {
  mkdirSync(afkHome(), { recursive: true })
  const body = [...map.values()].map((row) => JSON.stringify(row)).join("\n")
  writeFileSync(historyFile(), body ? body + "\n" : "")
}

const rowFromContainer = (c: LocalContainer): HistoryRow | null => {
  const runId = c.labels[LABEL_RUN_ID]
  if (!runId) return null
  const neutral = mapDockerState(c.state)
  const stopped = neutral === "STOPPED" || neutral === "STOPPING"
  const timeoutHours = Number(c.labels[LABEL_TIMEOUT_HOURS] ?? "0")
  return {
    runId,
    owner: c.labels[LABEL_OWNER] ?? LOCAL_OWNER_ID,
    repo: c.labels[LABEL_REPO] ?? "",
    branch: c.labels[LABEL_BRANCH] ?? "",
    sha: c.labels[LABEL_SHA] ?? "",
    image: c.labels[LABEL_IMAGE] ?? "",
    resourceId: c.id,
    status: stopped ? "STOPPED" : "RUNNING",
    startedAt: c.labels[LABEL_STARTED_AT] ?? c.startedAt,
    ...(stopped && c.finishedAt ? { stoppedAt: c.finishedAt } : {}),
    ...(stopped ? { exitCode: c.exitCode } : {}),
    timeoutHours: Number.isFinite(timeoutHours) ? timeoutHours : 0,
    backendDetails: {
      mainService: c.labels[LABEL_MAIN_SERVICE] ?? "",
    },
  }
}

export const LocalRunHistoryLive = Layer.effect(
  RunHistory,
  Effect.gen(function* () {
    const sub = yield* Subprocess

    return RunHistory.of({
      recordStart: (input) =>
        Effect.sync(() => {
          const map = readArchive()
          map.set(input.runId, {
            runId: input.runId,
            owner: input.owner,
            repo: input.repo,
            branch: input.branch,
            sha: input.sha,
            image: input.image,
            resourceId: input.resourceId,
            status: "RUNNING",
            startedAt: input.startedAt,
            timeoutHours: input.timeoutHours,
            ...(input.backendDetails
              ? { backendDetails: input.backendDetails }
              : {}),
          })
          writeArchive(map)
        }),

      recordComplete: (input) =>
        Effect.sync(() => {
          const map = readArchive()
          const existing = map.get(input.runId)
          if (!existing) return
          map.set(input.runId, {
            ...existing,
            status: "STOPPED",
            stoppedAt: input.stoppedAt,
            ...(input.exitCode !== undefined
              ? { exitCode: input.exitCode }
              : {}),
          })
          writeArchive(map)
        }),

      query: ({ since, owner, branch, limit }) =>
        Effect.gen(function* () {
          // Reconcile: the daemon is authoritative for containers that still
          // exist; the archive preserves the rest.
          const containers = yield* listAfkContainers(sub).pipe(
            Effect.catchAll(() =>
              Effect.succeed([] as ReadonlyArray<LocalContainer>),
            ),
          )
          const map = readArchive()
          for (const c of containers) {
            const row = rowFromContainer(c)
            if (row) map.set(row.runId, row)
          }
          writeArchive(map)

          const sinceIso = since ? DateTime.formatIso(since) : undefined
          return [...map.values()]
            .filter((r) => !owner || r.owner === owner)
            .filter((r) => !branch || r.branch === branch)
            .filter((r) => !sinceIso || r.startedAt >= sinceIso)
            .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
            .slice(0, limit ?? Number.MAX_SAFE_INTEGER)
        }),
    })
  }),
)
