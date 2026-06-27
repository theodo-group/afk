# GCP Backend

Each Run is one Compute Engine instance booted from the project's Golden Image (a GCE custom image), configured via a startup-script, and self-deleted on command exit. It follows the same one-VM-per-Run shape as AWS: full Compose Contract (host Docker daemon, real bridge networking, privileged-capable). Attach is over an IAP TCP tunnel — no public IP, no internet-facing SSH.

This document covers what the backend provisions and how its attach / lifecycle / cost specifics work.

## Prerequisites

- **`gcloud`** CLI installed and authenticated (`gcloud auth login`). The authenticated account is the Run's **Owner**.
- **A GCP project** with billing enabled, and `terraform` (>= 1.10) on PATH.
- **OS Login** at the org/project level (Terraform enables the role binding; the developer principal is mapped to a POSIX user automatically). `afk attach` relies on it.
- **IAP** — the developer principal needs `roles/iap.tunnelResourceAccessor` (granted by the module). The IAP TCP forwarding range `35.235.240.0/20` is the only ingress allowed to Run VMs.
- The required APIs (compute, iap, secretmanager, artifactregistry, firestore, logging, cloudfunctions, cloudscheduler, run, cloudbuild) — enabled by `apis.tf` at `afk provision`.

## End-to-end flow

1. `afk init --provider gcp [--region <region>]` resolves the project from your active gcloud config (`gcloud config set project <id>` first), creates the Terraform state GCS bucket (`afk-tf-state-<project_id>`), copies the Terraform module into `terraform/gcp/`, renders `backend.tf`, scaffolds `.afk.env` and the `gcp` block in `afk.config.json` (zone + machine-type defaults you can edit), and gitignores `.afk.env`. (Region defaults to `us-central1`; zone/machine type live in the config block, not flags.)
2. `afk provision` (or `terraform apply` from `terraform/gcp/`) enables the APIs, creates the VPC + subnet + Cloud NAT + IAP firewall, the `afk-vm` instance service account, the `afk-developer` custom role, the Firestore database + indexes, the Artifact Registry repo, the artifacts bucket, and the history-reconcile Cloud Function + Cloud Scheduler trigger. It binds the `afk-developer` role to your active gcloud principal.
3. `afk golden build` boots a short-lived builder VM, pre-pulls `gcp.cachedImages`, snapshots its disk into a GCE custom image labelled `afk-golden=true`, and deletes the builder.
4. `afk run` builds + pushes the agent image to Artifact Registry (`<region>-docker.pkg.dev/<project>/afk/...`), reads/lints `afk.compose.yml`, then calls `compute.instances.create` against the Golden Image with a templated startup-script — no external IP, labelled `afk-owner`/`afk-run-id`/`afk-branch`/`afk-sha`/`afk-managed=true`, with `scheduling.max_run_duration` set from `--timeout` and `instance_termination_action=DELETE`. Capacity is **Spot by default** (`provisioning-model=SPOT`); `--on-demand` selects `STANDARD`. `DELETE` covers both a preemption and the duration cap, so by default a Spot reclaim and a clean exit end the same way. `--retain` (On-Demand only) sets the termination action to `STOP` and self-stops instead, preserving the disk for post-mortem `afk attach` — see Run lifecycle.
5. The VM boots: the startup-script authenticates Docker to Artifact Registry (`gcloud auth configure-docker`), pulls the agent image, resolves `secret:<name>` vars from Secret Manager, writes the compose file, and runs the stack. The CLI-injected entrypoint clones the repo at the ref into `/workspace` and runs the command.
6. On command exit — at the **VM level**, not inside the container (mirroring how AWS self-terminates from `user_data`, not the entrypoint) — the startup-script uploads Session Artifacts to GCS, writes the completion row to Firestore, then runs `gcloud compute instances delete "$(hostname)" --zone=<zone> --quiet`. The `afk-vm` SA can delete only afk-managed VMs. GCE's `scheduling.max_run_duration` is the backstop if the VM never reaches that step.

## `afk.config.json` — the `gcp` block

```jsonc
{
  "backend": "gcp",
  "gcp": {
    "projectId": "my-project",
    "region": "us-central1",
    "zone": "us-central1-a",
    "defaultMachineType": "e2-standard-4",
    "allowedMachineTypes": [
      "e2-medium",
      "e2-standard-2",
      "e2-standard-4",
      "n2-standard-4"
    ],
    "cachedImages": ["postgres:16", "redis:7"]
  }
}
```

- `defaultMachineType` is used when `afk run` is called without `--machine-type`.
- `allowedMachineTypes` is the whitelist the CLI validates `--machine-type` against (and which the `afk-developer` IAM condition mirrors where expressible).
- `cachedImages` is the sidecar pre-pull list baked into the Golden Image by `afk golden build`.

## What Terraform provisions

Run once per GCP project/team.

### Networking

- A dedicated VPC + regional subnet with `private_ip_google_access` so VMs reach Google APIs without an external IP.
- Run VMs get **no external IP**. The only ingress firewall allows `tcp:22` from IAP's `35.235.240.0/20`; an explicit low-priority deny covers everything else.
- A Cloud Router + Cloud NAT for egress (image pulls, GitHub clone, the gcloud self-delete call).

### Identity

- An **`afk-vm`** service account attached to every Run VM. Grants: Artifact Registry reader; Secret Manager `secretAccessor` scoped to `afk-*` secrets via an IAM condition; Logging `logWriter`; Storage `objectCreator` on the artifacts bucket; and a custom self-reclaim role holding only `compute.instances.delete` + `compute.instances.stop` (a Run reclaims itself — delete, or stop when retained). Nothing else.
- An **`afk-developer`** custom role bound to developer principals: `compute.instances.create` (conditioned on the AFK subnet + machine-type whitelist where IAM conditions allow), `compute.instances.delete`, `compute.instances.start`/`stop` (resume + re-park a retained Run on attach), `iam.serviceAccountUser` on `afk-vm` only (the PassRole analogue — a developer can attach only the `afk-vm` SA), `roles/iap.tunnelResourceAccessor`, and `roles/compute.osLogin`.
- An **`afk-sweeper`** SA for the Cloud Function: `compute.instances.list/get` + `roles/datastore.user`, plus `compute.instances.delete` to reap retained VMs past the retention window. Delete is project-wide (the `afk-retain` label isn't an IAM-condition attribute — same gap noted below); the Function only ever deletes stopped `afk-managed` + `afk-retain` instances, enforced in code.

  > **IAM-condition limitation.** GCP IAM conditions cannot inspect arbitrary GCE instance *labels* at create/delete time (labels are request-body fields, not condition attributes). The label-based rules AWS expressed with `ec2:ResourceTag` conditions — `afk-owner == caller`, golden-image `afk-golden=true`, `afk-managed=true`, and owner-scoped attach — are therefore **enforced CLI-side**: the CLI stamps the labels, validates the image/owner/machine-type before `instances.create`, and resolves the Run via history (Owner-scoped) before tunnelling. The `iam.tf` comments mark each gap.

### Storage / state

- Terraform state lives in a GCS bucket (`afk-tf-state-<project_id>`), versioned. (Created by `afk init` first to avoid the chicken-and-egg; the module also declares it.)
- **Firestore (Native mode)** holds Run history in the `afk-runs` collection, with two composite indexes reproducing the DynamoDB GSIs: `(owner ASC, started_at DESC)` and `(repo ASC, started_at DESC)`.
- A **Session Artifacts** GCS bucket (`afk-artifacts-<project_id>`, `force_destroy`, uniform access, public access prevented, lifecycle expiry at 30 days). The Run VM uploads declared artifacts to `gs://<bucket>/<repo>/<runId>/session-artifacts/` before self-deleting (the VM SA has `objectCreator` only). `afk session-artifact <run-id>` syncs that prefix down.

### Not created by Terraform

- **The Golden Image** — built by `afk golden build`.
- **Artifact Registry image tags** — pushed by the CLI on `afk build`.
- **Secrets** — created by `afk secrets put` in Secret Manager (`afk-<name>`).

## Secrets

Stored in **Secret Manager** as `afk-<name>`. The startup-script resolves references at boot via the VM's `afk-vm` SA (`secretAccessor`, IAM-conditioned to the `afk-*` prefix) and exports them into the compose stack. Values never appear in instance metadata, labels, or logs.

## Logs

The Docker **`gcplogs`** driver is injected per compose service (labelled `runId` + `service`). `afk logs <run-id>` reads via `gcloud logging read` with a `jsonPayload.container.metadata.afk-run=…` filter (gcplogs writes container labels under the JSON payload's `container.metadata`, not at the entry's top-level `labels`); default = the main service, `--service <name>` = one service, `--all` = every service. `--follow` polls the logging API.

## Attach

`afk attach <run-id>` opens an **IAP TCP tunnel + OS Login** SSH session (`gcloud compute ssh --tunnel-through-iap`), then `docker exec`s into the main service's container.

- No inbound networking, no managed SSH keys — IAP terminates the authenticated tunnel and OS Login maps your Google principal to a POSIX user on the VM.
- Gated by `roles/iap.tunnelResourceAccessor`; Owner-scoping (only your own Runs) is enforced CLI-side via history lookup, since instance-label conditions aren't expressible in IAM.
- `--service <name>` exec's into a sidecar; `--host` drops to the VM's host shell (exposes the Docker socket — use deliberately).
- **Post-mortem (retained Runs).** Attaching a finished Run launched with `--retain` resumes it: the CLI starts the stopped instance (`gcloud compute ssh` retries until sshd is back), then — because the container has exited — **commits its final filesystem and drops you into a shell from that image**; `--host` gives the host shell instead. On detach the instance is stopped again; the reconcile Function reclaims it at the retention period. See `--retain` under Run lifecycle.

## Adding teammates

`afk provision` binds the `afkDeveloper` custom role onto the active gcloud principal only. To onboard another developer, bind an *existing* GCP principal to the same role — GCP doesn't create principals, so you pass the canonical IAM member string explicitly:

```sh
afk team add alice --principal user:alice@example.com
afk team add ci    --principal serviceAccount:ci@my-proj.iam.gserviceaccount.com
afk team ls
afk team rm alice
```

What this does:

- `add` binds the project-level `afkDeveloper` role onto `--principal`. That role already carries the permissions the developer needs (`compute.instances.create/delete` on afk-managed labels, `iam.serviceAccountUser` on `afk-vm`, `iap.tunnelResourceAccessor`, `compute.osLogin`) — defined once at provision time and reused across team members.
- `ls` enumerates the principals bound to the role.
- `rm` unbinds the principal from the role.

> The caller of `afk team add/rm` needs permission to edit project IAM (`resourcemanager.projects.setIamPolicy`) — typically project Owner or a custom IAM-admin role. Without it the IAM bind call fails and the developer was never added.

## Run lifecycle and reclaim

- A Run's lifetime equals its main service container's lifetime. On exit the startup-script writes the completion row, uploads Session Artifacts, flushes logs, then self-reclaims the instance with `gcloud compute instances delete`. The `afk-vm` SA can delete (and, for retained Runs, stop) only afk-managed VMs.
- **Timeout backstop is native GCE**: every instance is created with `scheduling.max_run_duration` (from `--timeout`, default capped by `max_run_timeout_hours`) and `instance_termination_action` set to `DELETE` (or `STOP` for a retained Run). If the agent crashes before the startup-script reaches self-reclaim, GCE applies that action when the duration elapses.
- **`--retain` (post-mortem inspection).** A Run launched with `--retain` is labelled `afk-retain=true`, has its termination action set to `STOP`, and self-**stops** instead of deleting on exit — preserving the boot disk (and exited containers) for later `afk attach` (see Attach). `--retain` implies On-Demand (`STANDARD`): a Spot VM cannot be stopped without losing its disk, so `--retain --spot` is a hard error. A retained instance is reclaimed by `afk kill` or by the reconcile Function once it is older than the retention period (`retention_days`, default 7). Opt-in because a stopped instance still bills for its boot disk.
- The **history-reconcile Cloud Function** (Cloud Scheduler, every 5 min) rewrites orphaned `RUNNING` Firestore rows to `STOPPED` for Runs whose VM has vanished, **and reaps retained VMs** (`afk-retain` + stopped) older than the retention window — the GCP analogue of the AWS sweeper's reaper.
- The CLI does not stay resident after `afk run`; a dead laptop doesn't affect the Run.

## Run state and querying

- `afk ls` → `compute.instances.list` filtered by labels (`afk-managed=true`, `afk-owner`).
- `afk ls --all` drops the owner filter (requires broader IAM).
- `afk history` reads the Firestore `afk-runs` collection.

## Costs

- VPC + Cloud NAT (small hourly + per-GB), Firestore (free tier covers low Run volume), the always-min-0 Cloud Function + Cloud Scheduler, Artifact Registry storage: low baseline.
- Per-Run: Compute Engine billed per second at the chosen machine type, boot disk, Cloud Logging ingest, NAT egress. **Spot by default** (`provisioning-model=SPOT`, 60–91% off standard) — `--on-demand` opts up to `STANDARD` for interruption-resistance on long Runs. A Spot reclaim DELETEs the VM mid-Run, same as a clean exit; the reconcile Cloud Function flips the orphaned history row. (Modern Spot VMs support `max_run_duration` + `instance_termination_action=DELETE`; this is not the legacy preemptible product.) A `--retain` Run (On-Demand) instead **stops** on exit — its **boot disk keeps billing while stopped** until reclaimed at the retention period, which is why retention is opt-in.

## Teardown

```sh
afk destroy            # dry-run: prints what would be deleted
afk destroy --yes      # terraform destroy + golden images, Artifact Registry
                       # images, Secret Manager secrets, and the TF state bucket
```
