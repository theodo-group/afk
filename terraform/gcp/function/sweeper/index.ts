/**
 * AFK history-reconcile Cloud Function (gen2, Node).
 *
 * Triggered by Cloud Scheduler (default: every 5 minutes). Two duties:
 *
 *   1. Reconcile the Firestore `afk-runs` collection. Any document still in
 *      status="running" whose backing Compute Engine instance no longer exists
 *      is flipped to "stopped" (stopped_at=now, exit_code=null) — the orphan
 *      case where a VM vanished (crash, preemption, or GCE `max_run_duration`
 *      deletion) without the entrypoint writing its own completion row.
 *
 *   2. Reap retained Runs: an afk-managed instance labelled afk-retain=true that
 *      is stopped (status TERMINATED) is a retained Run, resumable via
 *      `afk attach` until its window closes. Delete it once it is older than
 *      RETENTION_DAYS past its lastStopTimestamp (CONTEXT.md "Retention").
 *
 *   Status strings are lowercase to match what the CLI writes
 *   (`GcpRunHistory.recordStart/recordComplete`) and the AWS sweeper Lambda.
 *
 * Timeout-driven reclaim of *live* Runs is handled natively by GCE
 * `scheduling.max_run_duration`; this function only reaps *retained* stopped
 * VMs (the AWS sweeper Lambda's retention reaper analogue).
 *
 * Plain @google-cloud SDK, async/await. No Effect.
 */

import { Firestore } from "@google-cloud/firestore"
import { InstancesClient } from "@google-cloud/compute"

const PROJECT_ID = process.env.AFK_PROJECT_ID ?? ""
const RUNS_COLLECTION = process.env.AFK_RUNS_COLLECTION ?? "afk-runs"
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS ?? "7")
const DAY_MS = 86_400_000

const firestore = new Firestore({ projectId: PROJECT_ID })
const instances = new InstancesClient()

// The trailing segment of a GCE zone URL is the zone name.
const lastSegment = (url: string): string => url.split("/").pop() ?? url

/**
 * List the names of every afk-managed Compute Engine instance currently alive,
 * across all zones. We match the AWS sweeper's `tag:afk:managed=true` filter
 * using the label filter `labels.afk-managed=true`.
 */
async function listManagedInstanceNames(): Promise<Set<string>> {
  const names = new Set<string>()
  const iterable = instances.aggregatedListAsync({
    project: PROJECT_ID,
    filter: "labels.afk-managed=true",
  })
  for await (const [, scoped] of iterable) {
    for (const inst of scoped.instances ?? []) {
      if (inst.name) names.add(inst.name)
    }
  }
  return names
}

interface ExpiredRetained {
  readonly name: string
  readonly zone: string
  readonly ageDays: number
}

/**
 * Retained Runs (afk-retain=true) that are stopped (status TERMINATED) and
 * older than the retention window past their lastStopTimestamp. These are the
 * VMs to reclaim — the authoritative reaper for cloud retention on GCP.
 */
async function listExpiredRetained(nowMs: number): Promise<ExpiredRetained[]> {
  const out: ExpiredRetained[] = []
  const iterable = instances.aggregatedListAsync({
    project: PROJECT_ID,
    filter: "labels.afk-managed=true AND labels.afk-retain=true",
  })
  for await (const [, scoped] of iterable) {
    for (const inst of scoped.instances ?? []) {
      if (!inst.name) continue
      if (inst.status !== "TERMINATED") continue // GCE "stopped"
      const stopped = inst.lastStopTimestamp
        ? Date.parse(inst.lastStopTimestamp)
        : NaN
      if (!Number.isFinite(stopped)) continue
      if (nowMs < stopped + RETENTION_DAYS * DAY_MS) continue
      out.push({
        name: inst.name,
        zone: lastSegment(inst.zone ?? ""),
        ageDays: Math.floor((nowMs - stopped) / DAY_MS),
      })
    }
  }
  return out
}

async function reapInstance(name: string, zone: string): Promise<void> {
  await instances.delete({ project: PROJECT_ID, zone, instance: name })
}

interface RunningRow {
  readonly id: string
  readonly instanceName: string
}

async function listRunningRows(): Promise<RunningRow[]> {
  const snapshot = await firestore
    .collection(RUNS_COLLECTION)
    .where("status", "==", "running")
    .get()

  const rows: RunningRow[] = []
  for (const doc of snapshot.docs) {
    const data = doc.data()
    const instanceName = typeof data.instance_name === "string" ? data.instance_name : ""
    if (instanceName) rows.push({ id: doc.id, instanceName })
  }
  return rows
}

/**
 * Flip one orphaned row to stopped, guarding against a racing writer: only
 * write if the row is still "running" when the transaction reads it (the
 * entrypoint's own completion write wins if it lands first).
 */
async function reconcileRow(id: string): Promise<boolean> {
  const ref = firestore.collection(RUNS_COLLECTION).doc(id)
  return firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists) return false
    if (snap.data()?.status !== "running") return false
    tx.update(ref, {
      status: "stopped",
      stopped_at: new Date().toISOString(),
      exit_code: null,
      stop_reason: "reconcile: instance no longer exists",
    })
    return true
  })
}

/** Cloud Scheduler invokes this over HTTP (gen2 HTTP-triggered function). */
export const sweeper = async (
  _req: unknown,
  res: { status: (code: number) => { send: (body: string) => void } },
): Promise<void> => {
  const nowMs = Date.now()
  const [liveInstanceNames, runningRows, expiredRetained] = await Promise.all([
    listManagedInstanceNames(),
    listRunningRows(),
    listExpiredRetained(nowMs),
  ])

  const orphaned = runningRows.filter((r) => !liveInstanceNames.has(r.instanceName))

  let reconciled = 0
  for (const row of orphaned) {
    try {
      if (await reconcileRow(row.id)) reconciled++
    } catch (err) {
      console.warn(
        `sweeper: failed to reconcile run ${row.id}:`,
        (err as { message?: string }).message ?? String(err),
      )
    }
  }

  let reaped = 0
  for (const inst of expiredRetained) {
    try {
      await reapInstance(inst.name, inst.zone)
      reaped++
      console.log(
        `sweeper: reaped retained ${inst.name} (zone ${inst.zone}, retained ${inst.ageDays}d > ${RETENTION_DAYS}d)`,
      )
    } catch (err) {
      console.warn(
        `sweeper: failed to reap retained ${inst.name}:`,
        (err as { message?: string }).message ?? String(err),
      )
    }
  }

  console.log(
    `sweeper: ${runningRows.length} running row(s), ${liveInstanceNames.size} live VM(s), reconciled ${reconciled} orphan(s), reaped ${reaped} retained`,
  )
  res.status(200).send(`reconciled ${reconciled}, reaped ${reaped}`)
}
