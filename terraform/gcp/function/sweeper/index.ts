/**
 * AFK history-reconcile Cloud Function (gen2, Node).
 *
 * Triggered by Cloud Scheduler (default: every 5 minutes). It has exactly ONE
 * duty and is deliberately narrow:
 *
 *   Reconcile the Firestore `afk-runs` collection. Any document still in
 *   status="running" whose backing Compute Engine instance no longer exists is
 *   flipped to "stopped" (stopped_at=now, exit_code=null) — the orphan case
 *   where a VM vanished (crash, preemption, or GCE `max_run_duration` deletion)
 *   without the entrypoint writing its own completion row.
 *
 *   Status strings are lowercase to match what the CLI writes
 *   (`GcpRunHistory.recordStart/recordComplete`) and the AWS sweeper Lambda.
 *
 * It NEVER deletes VMs. Timeout-driven reclaim is handled natively by GCE
 * `scheduling.max_run_duration` + `instance_termination_action=DELETE` set at
 * launch — there is no instance reaper here (unlike the AWS sweeper Lambda).
 *
 * Plain @google-cloud SDK, async/await. No Effect.
 */

import { Firestore } from "@google-cloud/firestore"
import { InstancesClient } from "@google-cloud/compute"

const PROJECT_ID = process.env.AFK_PROJECT_ID ?? ""
const RUNS_COLLECTION = process.env.AFK_RUNS_COLLECTION ?? "afk-runs"

const firestore = new Firestore({ projectId: PROJECT_ID })
const instances = new InstancesClient()

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
  const [liveInstanceNames, runningRows] = await Promise.all([
    listManagedInstanceNames(),
    listRunningRows(),
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

  console.log(
    `sweeper: ${runningRows.length} running row(s), ${liveInstanceNames.size} live VM(s), reconciled ${reconciled} orphan(s)`,
  )
  res.status(200).send(`reconciled ${reconciled}`)
}
