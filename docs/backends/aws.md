# AWS Backend

Each Run is one EC2 instance booted from the project's Golden AMI, configured via `user_data`, and self-terminated on exit. Full Compose Contract supported (host Docker daemon, real bridge networking, privileged-capable).

See the [README quickstart](../../README.md#quickstart-on-aws) for the setup commands. This document covers what the backend provisions and how its attach / lifecycle / cost specifics work.

## End-to-end flow

1. `afk init --provider aws --region <region>` creates the Terraform state S3 bucket (`afk-tf-state-<account>-<region>`), copies the Terraform module into `terraform/afk/`, renders `backend.tf`, scaffolds `.afk.env` and `afk.config.json`, and gitignores `.afk.env`.
2. `afk provision` (or `terraform apply` from `terraform/afk/`) creates the VPC, security groups, IAM roles, the sweeper Lambda, and the developer IAM role.
3. `afk golden build` launches a short-lived builder EC2 instance, installs Docker, pre-pulls `aws.cachedImages`, snapshots an AMI tagged `afk:golden=true`, and terminates the builder.
4. `afk run` builds + pushes the agent image to ECR (`afk/<source-repo>`, lazy 7-day-lifecycle repo), reads/lints `afk.compose.yml`, then calls `ec2:RunInstances` against the Golden AMI with a templated `user_data` script — Spot by default (`--on-demand` opts into pricier on-demand capacity that AWS won't preempt mid-Run; both terminate on exit unless `--retain` is set — see Run lifecycle), tagged `afk:owner`/`afk:run-id`/`afk:branch`/`afk:sha`/`afk:managed`.
5. The VM boots: `user_data` authenticates to ECR, pulls the agent image, resolves `secret:<name>` vars from SSM, writes `/etc/afk/compose.yml`, and runs `timeout <N>h docker compose up --exit-code-from <main> --abort-on-container-exit` (or `docker run`). The CLI-injected entrypoint clones the repo at the ref into `/workspace` and execs the command.
6. On exit, compose tears down sidecars and `user_data` runs `shutdown -h now`; the instance was launched with `InstanceInitiatedShutdownBehavior=terminate`, so AWS terminates it.

## What Terraform provisions

Run once per AWS account/team.

### Networking

- A dedicated VPC across 2 AZs, public subnets only (no NAT), an Internet Gateway.
- A Security Group for Runs: **all inbound denied**, all outbound allowed. Run VMs get a public IP; inbound is unreachable, outbound goes direct.

### Compute

- No long-running compute. The CLI launches one EC2 instance per Run on demand against the Golden AMI.
- A **sweeper Lambda** (TypeScript, bundled at `terraform apply` time) on a 15-minute EventBridge schedule terminates AFK-managed instances older than their declared timeout — a backstop against crashed agents — and reaps retained (`afk:retain` + stopped) instances older than the retention period.

### Identity

- An `afk-vm-instance-role` attached to every Run VM. Grants: ECR pull on `afk/*`; `ssm:GetParameter(s)` on `/afk/*`; `logs:CreateLogStream` + `logs:PutLogEvents` on `/afk/*`. Nothing else — no `ec2:*`, no `iam:*`. The VM shuts itself down at the OS level; AWS terminates it.
- An `afk-sweeper-role` for the sweeper Lambda: `ec2:DescribeInstances`, `ec2:TerminateInstances` scoped to `tag:afk:managed=true` (covers both the timeout backstop and the retention reaper).
- An `afk-developer` role + policy granting:
  - `ec2:RunInstances` heavily conditioned: AMI must be `afk:golden=true` and owned by this account; subnet/VPC/SG must be the AFK ones; instance type must be in the whitelist; `aws:RequestTag/afk:owner` must equal `${aws:userid}`; `afk:run-id` must be present.
  - `iam:PassRole` scoped to **only** `afk-vm-instance-role`, with `iam:PassedToService=ec2.amazonaws.com`. The critical lockdown — without it a developer could attach an arbitrary role to a Run VM and escalate.
  - `ec2:CreateTags` at launch; `ec2:DescribeInstances` (read-only); `ec2:TerminateInstances` and `ssm:StartSession`/`TerminateSession` conditioned on `ec2:ResourceTag/afk:owner = ${aws:userid}`.
  - `ecr:*` on `afk/*`; `ssm:{Put,Get,Delete}Parameter` on `/afk/*`; `logs:{CreateLogGroup,PutRetentionPolicy,GetLogEvents}` on `/afk/*`.
- An admin attaches `afk-developer` to whichever IAM users/roles get access.

### Storage / state

- Terraform state lives in the S3 bucket created by `afk init` (not by Terraform — chicken-and-egg). S3 native state locking (`use_lockfile = true`).
- A DynamoDB `afk-runs` table holds Run history (used by `afk history`).
- A **Session Artifacts** S3 bucket (`afk-artifacts-<account>-<region>`, Terraform-managed, `force_destroy`, AES256, public access blocked). If `sessionArtifacts` is declared in `afk.config.json`, the Run VM `docker cp`s the declared base dirs out of the main service at graceful exit, drops files over the ~25 MB cap, and uploads the rest to `s3://<bucket>/<repo>/<runId>/session-artifacts/` before self-terminating (the VM role has `s3:PutObject` only). `afk session-artifact <run-id>` syncs that prefix down, applies the precise globs + cap, and writes the survivors to `--out`. Best-effort: a killed or hard-timed-out Run never reaches the upload. A lifecycle rule expires objects after 30 days, matching the log-retention window.

### Not created by Terraform

- **The Golden AMI** — built by `afk golden build`.
- **ECR repositories** — created lazily by the CLI on first `afk build`, with a 7-day untagged-image lifecycle.
- **CloudWatch log groups** (`/afk/<source-repo>`) — created lazily with 30-day retention.

## Secrets

Stored in **SSM Parameter Store SecureString** under `/afk/secrets/<name>`. The `user_data` script resolves references at boot via the VM's instance profile and exports them into the compose stack. Values never appear in `DescribeInstances`, CloudTrail (beyond the parameter name), or instance tags.

## Attach

`afk attach <run-id>` wraps `aws ssm start-session` against the EC2 instance, then `docker exec`s into the main service's container.

- AWS Systems Manager Session Manager — no inbound networking, no SSH keys. The Amazon Linux 2023 Golden Image ships the SSM agent.
- Gated by IAM (`ssm:StartSession`) with a tag condition restricting it to Runs the developer owns.
- `--service <name>` exec's into a sidecar; `--host` drops to the VM's host shell (exposes the Docker socket — use deliberately).
- Sessions are loggable to CloudWatch / S3 (Terraform variable, off by default).
- **Post-mortem (retained Runs).** Attaching a finished Run launched with `--retain` resumes it: the CLI starts the stopped instance, waits for the SSM agent to re-register, then — because the container has exited — **commits its final filesystem and drops you into a shell from that image** (the agent's `/workspace`, its scratch files). `--host` gives the host shell instead. On detach the instance is stopped again (back to retained); the sweeper reclaims it at the retention period. See `--retain` under Run lifecycle.

## Run lifecycle

- A Run's lifetime equals its main service container's lifetime. On exit the `user_data` script captures the code and runs `shutdown -h now`; the instance (launched with `InstanceInitiatedShutdownBehavior=terminate`) is terminated by AWS. No `ec2:TerminateInstances` permission is granted to the VM.
- A wall-clock timeout (default 4h) wraps compose with `timeout(1)`.
- The sweeper Lambda terminates instances whose agent crashed before reaching `shutdown` (older than the declared timeout, with a grace window).
- **`--retain` (post-mortem inspection).** A Run launched with `--retain` is tagged `afk:retain=true` and launched with `InstanceInitiatedShutdownBehavior=stop`, so on exit it **stops instead of terminating** — preserving the EBS root (and the exited containers) for later `afk attach` (see Attach). `--retain` implies On-Demand: Spot capacity cannot be stopped without losing its disk, so `--retain --spot` is a hard error. A retained instance is reclaimed by `afk kill` or by the sweeper once it is older than the retention period (`retention_days`, default 7); the sweeper's reaper query terminates `afk:retain` + stopped instances past that window. Opt-in because a stopped instance still bills for its EBS disk.
- The CLI does not stay resident after `afk run`; a dead laptop doesn't affect the Run.

## Run state and querying

- `afk ls` → `ec2:DescribeInstances` filtered by tags + instance-state. EC2 retains terminated instances for ~1 hour, so recent Runs stay visible.
- `afk ls --all` drops the owner filter (requires broader IAM).
- `afk history` reads the DynamoDB `afk-runs` table for older Runs.

## Costs

- VPC + IGW, no NAT/endpoints, sweeper Lambda + EventBridge, DynamoDB on-demand: ~$0 baseline.
- Per-Run: EC2 Spot compute (~70% off On-Demand), gp3 EBS root (~$0.08/GB-month, billed only while the instance exists), CloudWatch ingest, ECR storage (cycled at 7 days), data egress.
- Spot by default (cheaper, but interruptible — a Spot interruption kills the Run); `--on-demand` opts into pricier capacity AWS won't preempt. By default a Run terminates on exit, so `afk attach` only enters a *live* Run (declare a Session Artifact to capture post-Run state). `--retain` (On-Demand only) instead stops the instance for post-mortem inspection — its **EBS root keeps billing while stopped** until reclaimed at the retention period, which is why retention is opt-in.

## Teardown

```sh
afk destroy            # dry-run: prints what would be deleted
afk destroy --yes      # terraform destroy + golden AMI, ECR repo, SSM secrets,
                       # and the Terraform state bucket
```
