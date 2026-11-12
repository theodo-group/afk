/**
 * AFK sweeper Azure Function (Node, timer-triggered — default every 5 minutes).
 *
 * Three duties, all on afk-managed VMs of one resource group:
 *
 *   1. Timeout backstop. Azure has no native max-run-duration (GCE's
 *      `max_run_duration`), so each Run VM arms its own systemd timer at boot.
 *      This catches what that timer cannot: a VM that hung, or whose custom
 *      data died before arming it. A VM still up BACKSTOP_GRACE_MINUTES past
 *      `afk-started-at + afk-timeout-hours` is reclaimed — deallocated when it
 *      is a retained Run (stamped with afk-stopped-at), deleted otherwise.
 *
 *   2. Retention reaper. A deallocated VM tagged afk-retain=true is a retained
 *      Run, resumable via `afk attach`; once RETENTION_DAYS have passed since
 *      its afk-stopped-at stamp it is deleted (CONTEXT.md "Retention").
 *
 *   3. History reconcile. A row of the `afkruns` table still "running" whose
 *      VM no longer exists is flipped to "stopped" (no exit code: an absent
 *      exit code reads as a failure, never as "keep waiting").
 *
 * Status strings are lowercase to match what the CLI and the Run VM write.
 * Plain Azure SDK, async/await. No Effect.
 */

import { app, type InvocationContext } from "@azure/functions"
import { ComputeManagementClient, type VirtualMachine } from "@azure/arm-compute"
import { TableClient } from "@azure/data-tables"
import { DefaultAzureCredential } from "@azure/identity"

const SUBSCRIPTION_ID = process.env.AFK_SUBSCRIPTION_ID ?? ""
const RESOURCE_GROUP = process.env.AFK_RESOURCE_GROUP ?? "afk"
const STORAGE_ACCOUNT = process.env.AFK_STORAGE_ACCOUNT ?? ""
const RUNS_TABLE = process.env.AFK_RUNS_TABLE ?? "afkruns"
const SCHEDULE = process.env.AFK_SWEEPER_SCHEDULE ?? "0 */5 * * * *"
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS ?? "7")
const GRACE_MINUTES = Number(process.env.BACKSTOP_GRACE_MINUTES ?? "30")
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

const credential = new DefaultAzureCredential()
const compute = new ComputeManagementClient(credential, SUBSCRIPTION_ID)
const runs = new TableClient(
  `https://${STORAGE_ACCOUNT}.table.core.windows.net`,
  RUNS_TABLE,
  credential,
)

interface ManagedVm {
  readonly name: string
  readonly tags: Record<string, string>
  readonly powerState: string | undefined
}

async function powerStateOf(name: string): Promise<string | undefined> {
  const view = await compute.virtualMachines.instanceView(RESOURCE_GROUP, name)
  return view.statuses?.find((s) => s.code?.startsWith("PowerState/"))?.code
}

async function listManagedVms(): Promise<ManagedVm[]> {
  const vms: VirtualMachine[] = []
  for await (const vm of compute.virtualMachines.list(RESOURCE_GROUP)) {
    if (vm.tags?.["afk-managed"] === "true" && vm.name) vms.push(vm)
  }
  return Promise.all(
    vms.map(async (vm) => ({
      name: vm.name ?? "",
      tags: vm.tags ?? {},
      powerState: await powerStateOf(vm.name ?? "").catch(() => undefined),
    })),
  )
}

/** Pure: what the sweeper should do with one VM at `now`. */
export function verdict(
  vm: ManagedVm,
  now: number,
): "delete" | "deallocate" | "keep" {
  const retained = vm.tags["afk-retain"] === "true"
  if (vm.powerState === "PowerState/deallocated") {
    const stoppedAt = Date.parse(vm.tags["afk-stopped-at"] ?? "")
    return retained &&
      Number.isFinite(stoppedAt) &&
      now - stoppedAt > RETENTION_DAYS * DAY_MS
      ? "delete"
      : "keep"
  }
  const startedAt = Date.parse(vm.tags["afk-started-at"] ?? "")
  const timeoutHours = Number(vm.tags["afk-timeout-hours"] ?? "")
  if (!Number.isFinite(startedAt) || !Number.isFinite(timeoutHours)) return "keep"
  const deadline = startedAt + timeoutHours * HOUR_MS + GRACE_MINUTES * 60_000
  if (now <= deadline) return "keep"
  return retained ? "deallocate" : "delete"
}

async function reclaim(vms: ManagedVm[], now: number, ctx: InvocationContext) {
  for (const vm of vms) {
    const action = verdict(vm, now)
    if (action === "keep") continue
    try {
      if (action === "deallocate") {
        // Stamp the stop time first: the retention window runs from it.
        await compute.virtualMachines.beginUpdateAndWait(RESOURCE_GROUP, vm.name, {
          tags: { ...vm.tags, "afk-stopped-at": new Date(now).toISOString() },
        })
        await compute.virtualMachines.beginDeallocate(RESOURCE_GROUP, vm.name)
      } else {
        await compute.virtualMachines.beginDelete(RESOURCE_GROUP, vm.name)
      }
      ctx.log(`sweeper: ${action} ${vm.name}`)
    } catch (err) {
      ctx.warn(`sweeper: ${action} ${vm.name} failed: ${String(err)}`)
    }
  }
}

async function reconcile(liveNames: Set<string>, now: number, ctx: InvocationContext) {
  const rows = runs.listEntities<{ status?: string; vm_name?: string }>({
    queryOptions: { filter: "PartitionKey eq 'runs' and status eq 'running'" },
  })
  for await (const row of rows) {
    if (!row.vm_name || liveNames.has(row.vm_name)) continue
    try {
      await runs.updateEntity(
        {
          partitionKey: row.partitionKey ?? "runs",
          rowKey: row.rowKey ?? "",
          status: "stopped",
          stopped_at: new Date(now).toISOString(),
          stop_reason: "reconcile: VM no longer exists",
        },
        "Merge",
      )
      ctx.log(`sweeper: reconciled ${row.rowKey}`)
    } catch (err) {
      ctx.warn(`sweeper: reconcile ${row.rowKey} failed: ${String(err)}`)
    }
  }
}

export async function sweeper(_timer: unknown, ctx: InvocationContext): Promise<void> {
  const now = Date.now()
  const vms = await listManagedVms()
  await reclaim(vms, now, ctx)
  await reconcile(new Set(vms.map((v) => v.name)), now, ctx)
}

app.timer("sweeper", { schedule: SCHEDULE, handler: sweeper })
