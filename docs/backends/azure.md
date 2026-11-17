# Azure Backend

Each Run is one Azure Virtual Machine booted from the project's Golden Image (a generalized managed image), configured through custom data that cloud-init runs once on first boot, and deleted on command exit — or deallocated instead, when launched with `--retain`, for post-mortem inspection. It follows the same one-VM-per-Run shape as AWS and GCP: full Compose Contract (host Docker daemon, real bridge networking, privileged-capable). Attach goes through Azure Bastion with Microsoft Entra ID sign-in — no public IP on any Run VM.

This document covers what the backend provisions and how its attach / lifecycle / cost specifics work.

## Prerequisites

- **`az`** (Azure CLI) installed and signed in (`az login`; `az account set --subscription <id>`). The signed-in principal — a user's UPN or a service principal's appId — is the Run's **Owner**.
- The **`bastion`** and **`ssh`** az extensions, which `afk attach` rides: `az extension add --name bastion && az extension add --name ssh`.
- **Owner** (or Contributor + User Access Administrator) on the subscription for `afk init` / `afk provision`: the module creates role definitions and assignments.
- `terraform` (>= 1.10) and `npm` on PATH (the sweeper Function is bundled at apply time).

## End-to-end flow

1. `afk init --provider azure [--region <location>]` resolves the subscription from `az account show`, creates the Terraform state storage account (`afktf<suffix>`, in its own resource group `<resource-group>-tfstate`), copies the Terraform module into `terraform/azure/`, renders `backend.tf`, scaffolds `.afk.env` and the `azure` block in `afk.config.json`, and gitignores `.afk.env`. Location defaults to `westeurope`.
2. `afk provision` (or `terraform apply` from `terraform/azure/`) creates the resource group and everything in it (see below), and grants the `afk-developer-<suffix>` role and **Virtual Machine Administrator Login** to the signed-in principal.
3. `afk golden build` creates an Ubuntu 22.04 builder VM, runs the build script over the VM agent (`az vm run-command`: Docker, Compose, Azure CLI, then `azure.cachedImages` pre-pulled), deprovisions and generalizes it, captures a managed image tagged `afk-golden=true`, and deletes the builder.
4. `afk run` builds and pushes the agent image to the project's ACR (`afk<suffix>.azurecr.io/afk/<repo>:<tag>`), lints `afk.compose.yml`, then `az vm create`s from the newest Golden Image — no public IP, the `afk-vm` managed identity attached, tagged `afk-owner`/`afk-submitted-by`/`afk-run-id`/`afk-branch`/`afk-sha`/`afk-started-at`/`afk-timeout-hours`/`afk-managed=true`. Capacity is **Spot by default** (`--priority Spot --eviction-policy Delete`); `--on-demand` selects Regular. `--retain` (On-Demand only) deallocates instead of deleting on exit. The Entra ID SSH sign-in extension is installed on the VM right after.
5. The VM boots: the custom data signs in as the managed identity, arms a backstop timer (`systemd-run`, timeout + 10 min), logs Docker into ACR, pulls the agent image, resolves `secret:<name>` vars from Key Vault, writes the compose file, starts the log shipper, and runs the stack. The CLI-injected entrypoint clones the repo at the ref into `/workspace` and runs the command.
6. On command exit — at the VM level, like AWS and GCP — the custom data collects Session Artifacts to Blob storage, ships the last of the logs, writes the completion row (status + exit code) to the run index, and deletes its own VM (`az vm delete --ids <self>`); the NIC and OS disk go with it through their delete options. A retained Run instead stamps `afk-stopped-at` on itself and deallocates.

## `afk.config.json` — the `azure` block

```jsonc
{
  "backend": "azure",
  "azure": {
    "subscriptionId": "00000000-0000-0000-0000-000000000000",
    "location": "westeurope",
    "resourceGroup": "afk",
    "defaultVmSize": "Standard_D4s_v5",
    "allowedVmSizes": ["Standard_D2s_v5", "Standard_D4s_v5", "Standard_D8s_v5"],
    "osDiskSizeGb": 128,
    "cachedImages": ["postgres:16", "redis:7"]
  }
}
```

- `subscriptionId` must be the subscription `az` is signed in to; the CLI refuses rather than act on another one.
- `resourceGroup` names the group the module creates. Every global resource name (storage account, ACR, Key Vault, the developer role) is `afk` + a 12-hex hash of `<subscriptionId>/<resourceGroup>`, computed identically by the CLI and by Terraform, so the CLI never reads Terraform outputs.
- `defaultVmSize` is used when `afk run` has no `--instance-type`; `allowedVmSizes` is the whitelist it is validated against (CLI-side: Azure RBAC conditions cannot read a requested VM size).
- `osDiskSizeGb` sizes each Run's OS disk; absent, the Golden Image's size (30 GB) applies.

## What Terraform provisions

All in one resource group, so `afk destroy` (or deleting the group) removes everything — Run VMs and Golden images included.

### Networking

- A VNet with a private Run subnet (`afk-subnet`) whose outbound goes through a **NAT gateway** (`default_outbound_access_enabled = false`). Run VMs get **no public IP**.
- A subnet NSG that admits SSH only from the Bastion subnet and denies the rest of the VNet.
- **Azure Bastion** (Standard SKU, native-client tunnelling) — what `az network bastion ssh` connects through. Bastion bills hourly; `bastion_enabled = false` drops it for teams that never attach.

### Identity

- **`afk-vm`**, a user-assigned managed identity on every Run VM: `AcrPull` on the registry, `Key Vault Secrets User` on the vault, `Storage Blob Data Contributor` + `Storage Table Data Contributor` on the storage account, and a custom self-reclaim role (VM read/write/delete/deallocate, NIC and disk delete, tags write) on the resource group.
- **`afk-developer-<suffix>`**, a custom role on the resource group: create/delete/start/deallocate VMs and their NICs and disks, run commands on them (golden build), manage images, submit ARM deployments (`az vm create`), assign the `afk-vm` identity, push/pull ACR, read/write Key Vault secrets and run-index entities, read blobs. Paired with the built-in **Virtual Machine Administrator Login**, which is what lets `afk attach` sign in through Entra ID with sudo.
- The sweeper Function's system-assigned identity: VM read/write/delete/deallocate on the group and `Storage Table Data Contributor`.

  > **RBAC limitation.** As on GCP, Azure RBAC cannot scope VM deletion to "the VM calling" or to VMs carrying a tag, so the self-reclaim and sweeper roles are group-wide. The `afk-owner`, `afk-golden` and `afk-managed` rules are enforced CLI-side and in the sweeper's code.

### Storage

- **Azure Container Registry** (`afk<suffix>`, Standard, admin user disabled).
- **Key Vault** (`afk-<suffix>`, RBAC authorization). Secrets are `afk-secret-<name>`; Key Vault names allow only letters, digits and `-`, so a secret name with `_` is refused at `afk secrets put` and at `afk run`.
- A **storage account** (`afk<suffix>`) holding the run index (Table `afkruns`, one partition keyed by run id), the per-Run logs (`afk-logs/<runId>/<service>.log`) and Session Artifacts (`afk-artifacts/<repo>/<runId>/session-artifacts/`), both expired after `artifact_retention_days`.

### Sweeper

A timer-triggered Azure Function (`afk-sweeper-<suffix>`, Linux Consumption, Node 22), every 5 minutes: reclaims Runs still up `backstop_grace_minutes` past their timeout (Azure has no `max_run_duration`; the VM's own timer is the first line), deletes retained Runs older than `retention_days` past their `afk-stopped-at`, and flips orphaned `running` rows in the run index.

## Logs

Azure has no Docker log driver of its own, so the Run ships its logs the Cloudflare way: every 5 seconds a background loop re-dumps each service's `docker logs` and uploads whichever changed to `afk-logs/<runId>/<service>.log` (plus `combined.log` for `--all`). After the last pass it drops `afk-logs/<runId>/.done`. `afk logs` reads the blob; `--follow` polls it and stops after one final read once `.done` exists. `--since` is not honoured: the stored log is the Run's whole output.

## Attach

```sh
afk attach <run-id>            # main service
afk attach <run-id> --service postgres
afk attach <run-id> --host     # a login shell on the VM
```

Runs `az network bastion ssh --auth-type AAD` to the VM, signed in as your own Entra account, then `sudo docker exec -it` into the container. A retained Run is started first and deallocated again when the session ends; inside, the exited container is committed and a shell started from it.

## Run lifecycle and reclaim

| Event | Result |
| --- | --- |
| Command exits | Completion row written, VM deleted (NIC + disk with it) |
| Command exits, `--retain` | `afk-stopped-at` stamped, VM deallocated; resumable by `afk attach` for `retentionDays` |
| Timeout reached | `timeout` stops the workload; same as above |
| VM hung or custom data died | In-VM `systemd-run` timer at timeout + 10 min; then the sweeper at timeout + 30 min |
| Spot eviction | Azure deletes the VM; the run index row is reconciled to `stopped` with no exit code |
| `afk kill` | `az vm delete --no-wait` |

## Not supported yet

- **Schedules.** The Scheduler runs on AWS only; `afk schedule` refuses on Azure, naming the reason.
- **`afk logs --since`** (see Logs).

## Teardown

```sh
afk destroy --yes
```

Runs `terraform destroy` in `terraform/azure/`, which removes the whole resource group. The Terraform state's own resource group (`<resource-group>-tfstate`) is left for you to delete.
