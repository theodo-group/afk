/**
 * AFK sweeper Lambda.
 *
 * Three duties on every EventBridge tick (default: every 15 minutes):
 *
 *   1. Reclaim *running* AFK-managed EC2 instances past their afk:timeout-hours
 *      plus a grace window — the backstop for crashed agents that never reached
 *      `shutdown -h now` (AWS has no native max-run-duration). A non-retained
 *      overrun is terminated; a *retained* (afk:retain) overrun is **stopped**
 *      instead, so an overran or resumed-for-attach retained Run keeps its
 *      post-mortem state (the retention reaper, duty 2, reclaims it later).
 *
 *   2. Reap *retained* Runs: an AFK-managed instance tagged afk:retain=true that
 *      is stopped (not terminated) is a retained Run, resumable via `afk attach`.
 *      Terminate it once it is older than RETENTION_DAYS past the point it
 *      stopped (the authoritative reclamation — see CONTEXT.md "Retention").
 *
 *   3. Reconcile the DynamoDB run-history table. Any row still in
 *      status="running" whose EC2 instance is no longer in a live state is
 *      flipped to "stopped" (or "killed" if the sweeper itself terminated it
 *      on this tick) with stopped_at and a stop_reason.
 *
 * Safety: only acts on instances tagged afk:managed=true (enforced both
 * client-side by tag filter and IAM-side by the sweeper role's resource
 * condition).
 */

import {
  EC2Client,
  DescribeInstancesCommand,
  TerminateInstancesCommand,
  StopInstancesCommand,
  type Instance,
} from "@aws-sdk/client-ec2"
import {
  DynamoDBClient,
  ScanCommand,
  UpdateItemCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb"

const GRACE_MINUTES = Number(process.env.SWEEPER_GRACE_MINUTES ?? "30")
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS ?? "7")
const DAY_MS = 86_400_000
const REGION = process.env.AWS_REGION ?? "us-east-1"
const RUNS_TABLE = process.env.RUNS_TABLE ?? ""

const ec2 = new EC2Client({ region: REGION })
const ddb = new DynamoDBClient({ region: REGION })

interface ExpiredInstance {
  readonly instanceId: string
  readonly runId: string
  readonly owner: string
  readonly ageMinutes: number
  readonly timeoutMinutes: number
  /** A retained Run that overran is *stopped* (preserving retention), not
   *  terminated — the retention reaper reclaims it later. */
  readonly retain: boolean
}

const getTag = (i: Instance, key: string): string | undefined =>
  i.Tags?.find((t) => t.Key === key)?.Value

const parseStartedAt = (s: string | undefined): number | undefined => {
  if (!s) return undefined
  const n = Date.parse(s)
  return Number.isFinite(n) ? n : undefined
}

const collectExpired = (instances: ReadonlyArray<Instance>, nowMs: number): ExpiredInstance[] => {
  const out: ExpiredInstance[] = []
  for (const inst of instances) {
    if (!inst.InstanceId) continue
    const state = inst.State?.Name
    const startedAt =
      parseStartedAt(getTag(inst, "afk:started-at")) ??
      inst.LaunchTime?.getTime()
    if (startedAt === undefined) continue
    // Only a running/pending instance can overrun — there are no retained
    // (stopped) instances to reap.
    if (state !== "pending" && state !== "running") continue

    const timeoutHours = Number(getTag(inst, "afk:timeout-hours") ?? "4")
    if (!Number.isFinite(timeoutHours)) continue
    const deadlineMs =
      startedAt + timeoutHours * 3600 * 1000 + GRACE_MINUTES * 60 * 1000
    if (nowMs < deadlineMs) continue
    out.push({
      instanceId: inst.InstanceId,
      runId: getTag(inst, "afk:run-id") ?? "?",
      owner: getTag(inst, "afk:owner") ?? "?",
      ageMinutes: Math.floor((nowMs - startedAt) / 60000),
      timeoutMinutes: timeoutHours * 60,
      retain: getTag(inst, "afk:retain") === "true",
    })
  }
  return out
}

interface ReapedInstance {
  readonly instanceId: string
  readonly runId: string
  readonly owner: string
  readonly ageDays: number
}

// The parenthesised time in StateTransitionReason ("User initiated (2026-06-28
// 14:00:00 GMT)") is the only signal for when an instance stopped. Best-effort:
// an unparseable reason falls back to launch time so a retained instance can
// never linger past retention forever.
const parseStopTime = (i: Instance): number | undefined => {
  const m = i.StateTransitionReason?.match(/\(([^)]+)\)/)
  if (m) {
    const t = Date.parse(m[1]!)
    if (Number.isFinite(t)) return t
  }
  return i.LaunchTime?.getTime()
}

const collectExpiredRetained = (
  instances: ReadonlyArray<Instance>,
  nowMs: number,
  retentionDays: number,
): ReapedInstance[] => {
  const out: ReapedInstance[] = []
  for (const inst of instances) {
    if (!inst.InstanceId) continue
    if (inst.State?.Name !== "stopped") continue
    if (getTag(inst, "afk:retain") !== "true") continue
    const stoppedAt = parseStopTime(inst)
    if (stoppedAt === undefined) continue
    if (nowMs < stoppedAt + retentionDays * DAY_MS) continue
    out.push({
      instanceId: inst.InstanceId,
      runId: getTag(inst, "afk:run-id") ?? "?",
      owner: getTag(inst, "afk:owner") ?? "?",
      ageDays: Math.floor((nowMs - stoppedAt) / DAY_MS),
    })
  }
  return out
}

const liveStates = new Set(["pending", "running"])

async function reconcileHistory(
  killedRunIds: ReadonlySet<string>,
): Promise<{ updated: number }> {
  if (!RUNS_TABLE) return { updated: 0 }

  // Scan running rows. Volume is tiny (only "running" rows; finished rows
  // don't match the filter), so a Scan with a FilterExpression is fine.
  let exclusiveStartKey: Record<string, AttributeValue> | undefined
  const runningRows: { runId: string; instanceId: string }[] = []
  do {
    const page = await ddb.send(
      new ScanCommand({
        TableName: RUNS_TABLE,
        FilterExpression: "#s = :running",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":running": { S: "running" } },
        ProjectionExpression: "run_id, instance_id",
        ExclusiveStartKey: exclusiveStartKey,
      }),
    )
    for (const item of page.Items ?? []) {
      const rid = item.run_id?.S
      const iid = item.instance_id?.S
      if (rid && iid) runningRows.push({ runId: rid, instanceId: iid })
    }
    exclusiveStartKey = page.LastEvaluatedKey
  } while (exclusiveStartKey)

  if (runningRows.length === 0) return { updated: 0 }

  // Batch DescribeInstances against the live instances. EC2 returns "not
  // found" for terminated IDs (silently dropped), so we infer "gone" from
  // absence in the response.
  const instanceIds = runningRows.map((r) => r.instanceId)
  const desc = await ec2.send(
    new DescribeInstancesCommand({ InstanceIds: instanceIds.slice(0, 100) }),
  )
  const stateById = new Map<string, string>()
  for (const reservation of desc.Reservations ?? []) {
    for (const inst of reservation.Instances ?? []) {
      if (inst.InstanceId && inst.State?.Name) {
        stateById.set(inst.InstanceId, inst.State.Name)
      }
    }
  }

  const stoppedAt = new Date().toISOString()
  let updated = 0
  for (const { runId, instanceId } of runningRows) {
    const state = stateById.get(instanceId)
    if (state === undefined || !liveStates.has(state)) {
      const reason = killedRunIds.has(runId)
        ? "sweeper-terminated (past timeout + grace)"
        : `ec2-state:${state ?? "missing"}`
      const newStatus = killedRunIds.has(runId) ? "killed" : "stopped"
      try {
        await ddb.send(
          new UpdateItemCommand({
            TableName: RUNS_TABLE,
            Key: { run_id: { S: runId } },
            UpdateExpression:
              "SET #s = :s, stopped_at = :t, stop_reason = :r",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: {
              ":s": { S: newStatus },
              ":t": { S: stoppedAt },
              ":r": { S: reason },
              ":running": { S: "running" },
            },
            // Don't clobber if another writer beat us to it.
            ConditionExpression: "#s = :running",
          }),
        )
        updated++
      } catch (err) {
        if (
          (err as { name?: string }).name === "ConditionalCheckFailedException"
        ) {
          continue
        }
        console.warn(
          `sweeper: failed to update history row ${runId}:`,
          (err as { message?: string }).message ?? String(err),
        )
      }
    }
  }
  return { updated }
}

const describeAll = async (
  stateValues: ReadonlyArray<string>,
  extraFilters: ReadonlyArray<{ Name: string; Values: string[] }> = [],
): Promise<Instance[]> => {
  const out: Instance[] = []
  let nextToken: string | undefined
  do {
    const page = await ec2.send(
      new DescribeInstancesCommand({
        Filters: [
          { Name: "tag:afk:managed", Values: ["true"] },
          { Name: "instance-state-name", Values: [...stateValues] },
          ...extraFilters,
        ],
        NextToken: nextToken,
      }),
    )
    out.push(...(page.Reservations?.flatMap((r) => r.Instances ?? []) ?? []))
    nextToken = page.NextToken
  } while (nextToken)
  return out
}

export const handler = async (): Promise<{
  swept: number
  reaped: number
  reconciled: number
  details: ExpiredInstance[]
}> => {
  const nowMs = Date.now()

  // Duty 1: timeout backstop for live (pending/running) instances.
  const expired = collectExpired(
    await describeAll(["pending", "running"]),
    nowMs,
  )

  // Duty 2: reap retained (stopped + afk:retain) instances past their window.
  const reaped = collectExpiredRetained(
    await describeAll(["stopped"], [
      { Name: "tag:afk:retain", Values: ["true"] },
    ]),
    nowMs,
    RETENTION_DAYS,
  )

  // An overran *retained* Run is stopped (preserving retention for post-mortem
  // attach), not terminated — the retention reaper reclaims it later. Only
  // non-retained overruns and retention-expired instances are terminated.
  const expiredStop = expired.filter((e) => e.retain)
  const expiredTerminate = expired.filter((e) => !e.retain)
  const killedRunIds = new Set(expiredTerminate.map((e) => e.runId))
  const toTerminate = [
    ...expiredTerminate.map((e) => e.instanceId),
    ...reaped.map((r) => r.instanceId),
  ]
  const toStop = expiredStop.map((e) => e.instanceId)

  if (expired.length > 0) {
    console.log(
      `sweeper: ${expired.length} overran instance(s):`,
      expired.map(
        (e) =>
          `${e.instanceId} (run ${e.runId}, ${e.retain ? "retain→stop" : "terminate"}, age ${e.ageMinutes}m / ${e.timeoutMinutes}m)`,
      ),
    )
  }
  if (reaped.length > 0) {
    console.log(
      `sweeper: reaping ${reaped.length} retained instance(s) past ${RETENTION_DAYS}d:`,
      reaped.map((r) => `${r.instanceId} (run ${r.runId}, retained ${r.ageDays}d)`),
    )
  }
  if (toStop.length > 0) {
    await ec2.send(new StopInstancesCommand({ InstanceIds: toStop }))
  }
  if (toTerminate.length > 0) {
    await ec2.send(
      new TerminateInstancesCommand({ InstanceIds: toTerminate }),
    )
  }
  if (toStop.length === 0 && toTerminate.length === 0) {
    console.log("sweeper: nothing to stop or terminate")
  }

  const recon = await reconcileHistory(killedRunIds).catch((err) => {
    console.warn(
      "sweeper: history reconcile failed:",
      (err as { message?: string }).message ?? String(err),
    )
    return { updated: 0 }
  })
  console.log(`sweeper: history reconciled ${recon.updated} row(s)`)

  return {
    swept: expired.length,
    reaped: reaped.length,
    reconciled: recon.updated,
    details: expired,
  }
}
