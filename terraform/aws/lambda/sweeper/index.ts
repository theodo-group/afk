/**
 * AFK sweeper Lambda.
 *
 * Two duties on every EventBridge tick (default: every 15 minutes):
 *
 *   1. Terminate expired AFK-managed EC2 instances:
 *        - a *running* instance past its afk:timeout-hours plus a grace window
 *          (backstop for crashed agents that never reached `shutdown -h now`);
 *        - a *stopped* (retained) instance past afk:started-at +
 *          afk:retention-days — reclaiming a retained Run once its window
 *          closes (the retention reaper; see CONTEXT.md "Retention").
 *
 *   2. Reconcile the DynamoDB run-history table. Any row still in
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
  type Instance,
} from "@aws-sdk/client-ec2"
import {
  DynamoDBClient,
  ScanCommand,
  UpdateItemCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb"

const GRACE_MINUTES = Number(process.env.SWEEPER_GRACE_MINUTES ?? "30")
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
  /** Why it's being reclaimed: overran its run timeout, or past its retention window. */
  readonly kind: "timeout" | "retention"
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

    let deadlineMs: number
    let kind: "timeout" | "retention"
    if (state === "pending" || state === "running") {
      // Running too long: timeout + grace backstop.
      const timeoutHours = Number(getTag(inst, "afk:timeout-hours") ?? "4")
      if (!Number.isFinite(timeoutHours)) continue
      deadlineMs = startedAt + timeoutHours * 3600 * 1000 + GRACE_MINUTES * 60 * 1000
      kind = "timeout"
    } else if (state === "stopped") {
      // Retained too long. Only instances tagged afk:retention-days are
      // AFK-retained; a stopped instance without it isn't ours to reclaim.
      const retentionDays = Number(getTag(inst, "afk:retention-days"))
      if (!Number.isFinite(retentionDays)) continue
      deadlineMs = startedAt + retentionDays * 86400 * 1000
      kind = "retention"
    } else {
      continue
    }
    if (nowMs < deadlineMs) continue
    out.push({
      instanceId: inst.InstanceId,
      runId: getTag(inst, "afk:run-id") ?? "?",
      owner: getTag(inst, "afk:owner") ?? "?",
      ageMinutes: Math.floor((nowMs - startedAt) / 60000),
      timeoutMinutes: kind === "timeout"
        ? Number(getTag(inst, "afk:timeout-hours") ?? "4") * 60
        : Number(getTag(inst, "afk:retention-days") ?? "0") * 24 * 60,
      kind,
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

export const handler = async (): Promise<{
  swept: number
  reconciled: number
  details: ExpiredInstance[]
}> => {
  const nowMs = Date.now()
  const expired: ExpiredInstance[] = []
  let nextToken: string | undefined

  do {
    const page = await ec2.send(
      new DescribeInstancesCommand({
        Filters: [
          { Name: "tag:afk:managed", Values: ["true"] },
          {
            Name: "instance-state-name",
            // running/pending → timeout backstop; stopped → retention reaper.
            Values: ["pending", "running", "stopped"],
          },
        ],
        NextToken: nextToken,
      }),
    )
    const instances =
      page.Reservations?.flatMap((r) => r.Instances ?? []) ?? []
    expired.push(...collectExpired(instances, nowMs))
    nextToken = page.NextToken
  } while (nextToken)

  const killedRunIds = new Set(expired.map((e) => e.runId))

  if (expired.length > 0) {
    console.log(
      `sweeper: terminating ${expired.length} expired instance(s):`,
      expired.map(
        (e) =>
          `${e.instanceId} (run ${e.runId}, ${e.kind}, age ${e.ageMinutes}m / ${e.timeoutMinutes}m)`,
      ),
    )
    await ec2.send(
      new TerminateInstancesCommand({
        InstanceIds: expired.map((e) => e.instanceId),
      }),
    )
  } else {
    console.log("sweeper: no expired instances to terminate")
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
    reconciled: recon.updated,
    details: expired,
  }
}
