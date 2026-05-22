/**
 * AFK sweeper Lambda.
 *
 * Runs on an EventBridge schedule (default: every 15 minutes). Lists every
 * EC2 instance tagged afk:managed=true, computes age from afk:started-at,
 * compares to afk:timeout-hours plus a configurable grace window, and
 * terminates anything past the deadline.
 *
 * Safety: only terminates instances that carry afk:managed=true (enforced
 * both client-side by tag filter and IAM-side by the sweeper role's resource
 * condition).
 */

import {
  EC2Client,
  DescribeInstancesCommand,
  TerminateInstancesCommand,
  type Instance,
} from "@aws-sdk/client-ec2"

const GRACE_MINUTES = Number(process.env.SWEEPER_GRACE_MINUTES ?? "30")
const REGION = process.env.AWS_REGION ?? "us-east-1"

const ec2 = new EC2Client({ region: REGION })

interface ExpiredInstance {
  readonly instanceId: string
  readonly runId: string
  readonly owner: string
  readonly ageMinutes: number
  readonly timeoutMinutes: number
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
    if (inst.State?.Name !== "pending" && inst.State?.Name !== "running") continue
    const startedAt =
      parseStartedAt(getTag(inst, "afk:started-at")) ??
      inst.LaunchTime?.getTime()
    if (startedAt === undefined) continue
    const timeoutHours = Number(getTag(inst, "afk:timeout-hours") ?? "4")
    if (!Number.isFinite(timeoutHours)) continue
    const deadlineMs = startedAt + timeoutHours * 3600 * 1000 + GRACE_MINUTES * 60 * 1000
    if (nowMs < deadlineMs) continue
    out.push({
      instanceId: inst.InstanceId,
      runId: getTag(inst, "afk:run-id") ?? "?",
      owner: getTag(inst, "afk:owner") ?? "?",
      ageMinutes: Math.floor((nowMs - startedAt) / 60000),
      timeoutMinutes: timeoutHours * 60,
    })
  }
  return out
}

export const handler = async (): Promise<{ swept: number; details: ExpiredInstance[] }> => {
  const nowMs = Date.now()
  const expired: ExpiredInstance[] = []
  let nextToken: string | undefined

  do {
    const page = await ec2.send(
      new DescribeInstancesCommand({
        Filters: [
          { Name: "tag:afk:managed", Values: ["true"] },
          { Name: "instance-state-name", Values: ["pending", "running"] },
        ],
        NextToken: nextToken,
      }),
    )
    const instances =
      page.Reservations?.flatMap((r) => r.Instances ?? []) ?? []
    expired.push(...collectExpired(instances, nowMs))
    nextToken = page.NextToken
  } while (nextToken)

  if (expired.length === 0) {
    console.log("sweeper: nothing to terminate")
    return { swept: 0, details: [] }
  }

  console.log(
    `sweeper: terminating ${expired.length} expired instance(s):`,
    expired.map((e) => `${e.instanceId} (run ${e.runId}, ${e.ageMinutes}m / ${e.timeoutMinutes}m + grace)`),
  )

  await ec2.send(
    new TerminateInstancesCommand({
      InstanceIds: expired.map((e) => e.instanceId),
    }),
  )

  return { swept: expired.length, details: expired }
}
