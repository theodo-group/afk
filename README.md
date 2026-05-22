# AFK

Run ephemeral containerized tasks in the cloud from a CLI. Built for AI agents that work while you're AFK ("away from keyboard"), but works for any cli-runnable workload.

Each Run executes on a short-lived VM that the developer owns end-to-end. The VM has Docker installed, so the Run can `docker compose up` against the host daemon — giving the agent first-class access to sidecar services (Postgres, Redis, etc.) without the limitations of serverless container platforms.

This repository is the **base layer**: it ships the Terraform that provisions the cloud infra, the CLI that drives it, and the contract that consumers must follow in their own repos.

---

## Concepts

See [`CONTEXT.md`](./CONTEXT.md) for the canonical glossary. Quick orientation:

- **Run** — one ephemeral execution of a developer-defined command, backed by exactly one EC2 instance. The VM boots, runs the workload, and self-terminates on exit.
- **Backend** — cloud-provider implementation. AWS EC2 first; GCP (Compute Engine) and Azure (Virtual Machines) anticipated.
- **Owner** — the IAM principal that launched a Run. Used for access control.
- **Dockerfile Contract** — the rules a consumer's `afk.Dockerfile` must follow.
- **Compose Contract** — the (optional) rules a consumer's `afk.compose.yml` must follow when the Run needs sidecar services.
- **Golden Image** — the AMI used as the boot image for every Run. Pure Docker cache, nothing more.
- **Ref** — the git reference a Run executes against.

---

## How it works (end-to-end)

1. Developer runs `afk init --provider aws` in their repo once. CLI creates the Terraform state S3 bucket, copies the matching Backend Terraform module into their repo (`terraform/aws/` → consumer's `terraform/afk/`), scaffolds `.afk.env` and `afk.config.json` (with `backend: "aws"`), gitignores `.afk.env`. `--provider` defaults to `aws` while it is the only supported Backend.
2. Developer runs `terraform apply` from `terraform/afk/`. This creates the VPC, security groups, IAM roles and policies, the sweeper Lambda, and the developer IAM role.
3. Developer builds the Golden Image: `afk image build`. The CLI launches a short-lived builder EC2 instance, installs Docker, pre-pulls the images listed in `afk.config.json` under `golden.cachedImages`, snapshots the result as an AMI tagged `afk:golden=true`, and terminates the builder.
4. Developer stores their GitHub Personal Access Token: `afk secrets put github-token <PAT>`.
5. Developer runs `afk run "claude -p 'fix the failing tests'"`. The CLI:
   - Refuses if the working tree is dirty or the current branch isn't pushed to origin.
   - Refuses if no Golden Image exists in this account/region.
   - Builds the Docker image if no image exists for `<branch>-<sha>` in ECR (otherwise skips). The build runs `docker build -f afk.Dockerfile .` and wraps the dev's `afk.Dockerfile` with a CLI-owned entrypoint.
   - Pushes the image to the ECR repository `afk/<source-repo>` (creating it lazily with a 7-day lifecycle if absent).
   - Reads `afk.compose.yml` from the working tree if present, lints it, and substitutes `${AFK_IMAGE}` with the ECR URI.
   - Calls `ec2:RunInstances` against the Golden AMI with a templated `user_data` script, Spot market by default (override with `--on-demand`), tagged `afk:owner=<principal>`, `afk:run-id=<id>`, `afk:branch=<branch>`, `afk:sha=<sha>`, `afk:managed=true`.
   - Returns the Run ID and exits.
6. The VM boots. The `user_data` script:
   - Authenticates to ECR via the instance profile and pulls the agent image.
   - Resolves `ssm:` env vars from SSM Parameter Store.
   - Writes the compose file to `/etc/afk/compose.yml` (or skips if no compose file was provided).
   - Runs `timeout <N>h docker compose up --exit-code-from <main-service> --abort-on-container-exit` (or `docker run` if no compose file).
   - The CLI-injected entrypoint inside the main service's container reads `AFK_GIT_URL`, `AFK_GIT_REF`, and the GitHub token, clones the repo at the ref into `/workspace`, then `exec`s the dev's command.
7. Developer optionally attaches: `afk attach <run-id>` opens an interactive shell into the main service's container via SSM Session Manager + `docker exec`.
8. The agent does its work (typically pushing results to a branch, opening a PR, or whatever the agent is wired to do). Each container's stdout/stderr ships to CloudWatch Logs via the Docker `awslogs` driver, under `/afk/<source-repo>` (30-day retention), stream-prefixed by `<run-id>/<service-name>`.
9. The agent's command exits → compose tears down sidecars → the `user_data` script calls `shutdown -h now`. The VM was launched with `InstanceInitiatedShutdownBehavior=terminate`, so AWS terminates the instance.
10. The sweeper Lambda runs every 15 minutes and terminates any AFK-managed instance older than its configured timeout (defense against crashed agents).
11. Developer reads results: `afk logs <run-id>` or wherever the agent published its output.

---

## Repository layout

```
/
├── CONTEXT.md              # canonical glossary
├── README.md               # this file
├── cli/                    # TypeScript CLI, run with Bun
│   ├── src/
│   ├── package.json
│   └── tsconfig.json
├── terraform/              # copyable modules, split by Backend (afk init drops the selected one into the dev's repo)
│   └── aws/                # AWS Backend — EC2 VM per Run (only Backend supported in v1)
│       ├── main.tf
│       ├── vpc.tf
│       ├── iam.tf
│       ├── sweeper.tf
│       ├── lambda/
│       │   └── sweeper/    # sweeper Lambda source (TypeScript, bundled at apply time)
│       ├── variables.tf
│       └── outputs.tf
│   # future: gcp/, azure/
├── entrypoint/             # CLI-injected container entrypoint
│   └── entrypoint.sh
└── examples/               # example consumer repos
```

---

## Distribution & install

This repo is **not published to a registry**. Developers consume it by cloning.

```sh
git clone <this-repo> ~/afk
cd ~/afk/cli
bun install
bun link              # puts `afk` on PATH
```

Prerequisites on the developer machine:

- Bun (runtime)
- Docker (image builds)
- Terraform ≥ 1.10 (for S3 native state locking)
- AWS CLI (credential chain) with creds for the target account

Updates: `git pull && bun install`. There is no version pinning; consumers run whatever sha they checked out.

---

## The consumer contract

A repo that wants to use AFK must provide:

### 1. An `afk.Dockerfile` at the repo root

The file **must** be named `afk.Dockerfile` so it is namespaced away from any other Dockerfile the project uses for its own deployment.

- Installs the toolchain and dependencies needed by the Run's command.
- **Does not `COPY` source code.** Source is cloned at Run start.
- **Does not declare `ENTRYPOINT`.** The CLI injects one at build time.
- Leaves `/workspace` writable. The entrypoint will clone source there.

Example:

```dockerfile
FROM node:20
RUN apt-get update && apt-get install -y git
RUN npm install -g @anthropic-ai/claude-code
WORKDIR /workspace
```

### 2. (Optional) `afk.compose.yml` at the repo root

When the Run needs sidecar services, declare them in a compose file. One service — the "main service," named in `afk.config.json` (default: `agent`) — is the agent; its image must be `${AFK_IMAGE}` (the CLI substitutes the ECR URI at submit time). Other services are stock images.

```yaml
services:
  agent:
    image: ${AFK_IMAGE}
    command: ${AFK_COMMAND}
    env_file: ["${AFK_ENV_FILE}"]
    depends_on: [postgres, redis]
    environment:
      DATABASE_URL: postgres://afk:afk@postgres:5432/afk
      REDIS_URL: redis://redis:6379
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: afk
      POSTGRES_PASSWORD: afk
      POSTGRES_DB: afk
  redis:
    image: redis:7
```

The CLI exports three shell variables before invoking `docker compose up` on the VM, which compose substitutes into the above file:

- `AFK_IMAGE` — the ECR URI of the wrapped agent image the CLI just pushed.
- `AFK_COMMAND` — the command from `afk run <args…>` as a shell-quoted string. If the dev's main service hardcodes `command:`, that wins instead.
- `AFK_ENV_FILE` — path to a file containing every value from `.afk.env` plus AFK-injected variables (`AFK_GIT_URL`, `AFK_GIT_REF`, `AFK_RUN_ID`, `AFK_TIMEOUT_SECONDS`, decrypted SSM secrets). The main service must reference it via `env_file:` to receive them.

Restrictions enforced by the CLI at submit time:
- No `restart: always` or `restart: unless-stopped` on the main service (would fight Run-ends-on-exit semantics).
- `ports:` on any service generates a warning — inbound is unreachable at the security-group level.
- The main service must reference `${AFK_IMAGE}`.
- Missing `env_file:` on the main service produces a warning (the entrypoint will fail without `AFK_GIT_URL` / `GITHUB_TOKEN`).

Sidecars share the VM's Docker daemon and the VM's network. `/workspace` is mounted into the main service only; declare a named volume in the compose file if other services need source access.

### 3. `afk.config.json`

```json
{
  "backend": "aws",
  "gitUrl": "https://github.com/you/your-repo.git",
  "mainService": "agent",
  "defaultInstanceType": "m6a.large",
  "allowedInstanceTypes": [
    "t3.medium", "t3.large", "t3.xlarge",
    "m6a.large", "m6a.xlarge", "m6a.2xlarge", "m6a.4xlarge"
  ],
  "defaultTimeoutHours": 4,
  "golden": {
    "cachedImages": ["postgres:16", "redis:7", "node:20"]
  }
}
```

`backend` and `gitUrl` are required. `mainService` defaults to `agent`. Resource and Golden-Image settings are optional.

Backend-specific knobs, when they exist, are namespaced under the backend name (e.g. `"aws": { "region": "us-east-1" }`). Most runtime values the CLI needs (VPC ID, subnet IDs, role ARNs) are read from `terraform output -json`, not from this file.

### 4. `.afk.env` (gitignored)

Contains environment variables for Runs. Values may be plain strings (for non-secrets) or SSM references (for secrets).

```
LOG_LEVEL=debug
ANTHROPIC_API_KEY=ssm:/afk/anthropic-key
DATABASE_URL=ssm:/afk/db-url
```

Secrets themselves are stored separately via `afk secrets put <name> <value>` (writes to SSM Parameter Store SecureString) and referenced from `.afk.env`.

---

## CLI surface

```
afk init [--provider aws|gcp|azure]            # one-time setup in a repo; selects Backend (default aws)
afk doctor                                     # check dependencies, AWS creds, Golden Image presence + age
afk config                                     # print resolved config (debug)

afk image build [--local]                      # build the Golden Image AMI from afk.config.json's cache list
afk image ls                                   # list Golden Image AMIs in this account/region
afk image rm <ami-id>                          # delete a Golden Image AMI

afk build [--ref <ref>] [--local]              # explicit container image build + push (afk run also builds if needed)
afk run <command…>                             # launch a Run
  --ref <branch|sha|tag>                       #   defaults to current local branch
  --instance-type <type>                       #   overrides project default
  --on-demand                                  #   disable Spot for this Run (default is Spot)
  --timeout <hours>                            #   overrides default (4h)
  --detach / -d                                #   default: launch and exit; without -d, streams logs
  --local                                      #   use the Local Backend (Docker on this machine) for this invocation
afk ls [--all] [--status <s>] [--local]        # list Runs (yours by default; --all = team-wide if permitted)
afk attach <run-id> [--service <name>] [--host] [--local]
                                               # interactive shell. Default: docker exec into main service.
                                               # --service <name>: attach to a sidecar instead.
                                               # --host: drop to the VM's host shell (cloud only).
afk logs <run-id> [--follow] [--service <name>] [--local]
                                               # tail logs (CloudWatch, or `docker compose logs` when --local)
afk kill <run-id> [--local]                    # stop a Run
afk gc [--local]                               # prune stopped containers older than 7d (Local only; cloud is auto-reaped)

afk secrets put <name> [value]                 # write to SSM (prompts if value omitted)
afk secrets ls                                 # list stored secret names
afk secrets rm <name>                          # delete from SSM

afk team add <name> [--principal <arn>]        # admin: provision a developer (IAM user or trusted principal)
afk team ls                                    # admin: list members
afk team rm <name>                             # admin: revoke access

# Global flags
--json                                         # machine-readable JSON output
--verbose / -v                                 # debug logging
--quiet / -q                                   # errors only
```

All AWS calls go through the standard credential chain (`AWS_PROFILE`, env vars, IMDS). Developers act under an IAM role provisioned by the Terraform. The `team` commands require admin IAM permissions (separate policy output by the Terraform).

---

## What the Terraform provisions

A consumer of this repo runs the Terraform once per AWS account/team. It creates:

### Networking

- A dedicated VPC across 2 AZs.
- Public subnets only (no NAT).
- An Internet Gateway.
- A Security Group for Runs: **all inbound denied**, all outbound allowed.
- Run VMs launch with a public IP. Inbound is unreachable; outbound goes direct.

### Compute

- No long-running compute. The CLI launches one EC2 instance per Run on demand against the Golden AMI.
- A **sweeper Lambda** (TypeScript, bundled at `terraform apply` time) on a 15-minute EventBridge schedule. It terminates AFK-managed instances older than their declared timeout. Backstop against crashed agents.

### Identity

- An `afk-vm-instance-role` — the role attached to every Run VM. Grants:
  - ECR pull on `afk/*` repositories.
  - `ssm:GetParameter` / `GetParameters` on `/afk/*`.
  - `logs:CreateLogStream`, `logs:PutLogEvents` on `/afk/*` log groups.
  - Nothing else. No `ec2:*`, no `iam:*`. The VM does not call `TerminateInstances`; it shuts itself down at the OS level and AWS terminates the instance.
- An `afk-sweeper-role` for the sweeper Lambda: `ec2:DescribeInstances`, `ec2:TerminateInstances` scoped to `tag:afk:managed=true`.
- An `afk-developer` role + policy. The policy grants:
  - `ec2:RunInstances` heavily conditioned: AMI must be tagged `afk:golden=true` and owned by this account; subnet, VPC, and security group must be the AFK ones; instance type must be in the project whitelist; `aws:RequestTag/afk:owner` must equal the caller's `${aws:userid}`; `afk:run-id` tag must be present.
  - `iam:PassRole` scoped to **only** `afk-vm-instance-role`, with `iam:PassedToService=ec2.amazonaws.com`. This is the critical lockdown — without it, a developer could attach an arbitrary role to a Run VM and escalate.
  - `ec2:CreateTags` at launch.
  - `ec2:DescribeInstances` (no resource scope — read-only).
  - `ec2:TerminateInstances` conditioned on `ec2:ResourceTag/afk:owner = ${aws:userid}` (developers kill only their own Runs).
  - `ssm:StartSession` / `TerminateSession` conditioned on `ec2:ResourceTag/afk:owner = ${aws:userid}`.
  - `ecr:*` scoped to repositories prefixed `afk/*`.
  - `ssm:PutParameter`, `ssm:GetParameter`, `ssm:DeleteParameter` scoped to `/afk/*`.
  - `logs:CreateLogGroup`, `logs:PutRetentionPolicy`, `logs:GetLogEvents` scoped to `/afk/*`.
- An admin attaches `afk-developer` to whichever IAM users/roles should have access.

### Storage / state

- The Terraform state itself lives in an S3 bucket created by `afk init` (not by Terraform — chicken-and-egg). S3 native state locking (`use_lockfile = true`) replaces the older DynamoDB pattern.

### Not created by Terraform

- **The Golden AMI** is built by `afk image build`, not by Terraform. The Terraform grants the permission scope only.
- **ECR repositories** are created lazily by the CLI on first `afk build` for a given source repo, with a 7-day untagged-image lifecycle policy applied at creation.
- **CloudWatch log groups** (`/afk/<source-repo>`) are created lazily by the CLI with 30-day retention.

---

## Local Backend

Every command (except `afk image build`) accepts `--local` to execute against the developer's local Docker daemon instead of the configured cloud Backend. The point is faithful rehearsal: same image build, same CLI-injected entrypoint, same `.afk.env` resolution (including `ssm:` references, which the CLI dereferences client-side via `ssm:GetParameter`), same compose file, same wall-clock timeout, same git-clone-from-origin source handling.

What is the same as cloud:
- Dirty-tree and unpushed-ref refusal — Local enforces both, identical to cloud.
- Image build pipeline — wrapper Dockerfile, CLI-injected entrypoint, same tag format. Image stays in the local Docker daemon; no ECR push.
- Compose file consumption — Local runs `docker compose up --exit-code-from <main-service>` against the same `afk.compose.yml`.
- Secret resolution — `ssm:` references in `.afk.env` are fetched from SSM by the CLI and passed as environment variables to the compose stack.
- Lifecycle — entrypoint clones source at the configured ref, executes the command under a `timeout(1)` wrapper, exits.

What differs from cloud:
- No VM, no Golden AMI, no ECR push, no IAM, no SSM. `afk image build --local` refuses with a message ("the Golden Image is a cloud concept; your local Docker daemon already caches what it pulls").
- Containers carry labels (`afk.managed=true`, `afk.run-id=<id>`, `afk.repo=<repo>`, `afk.ref=<sha>`) so `afk ls --local`, `afk attach --local`, etc. can find them via `docker ps --filter`.
- `afk attach --local [--service <name>]` uses `docker exec -it`; `afk logs --local` uses `docker compose logs -f`; `afk kill --local` uses `docker compose down -v`.
- No owner tag — your machine, one user. `afk ls --all --local` silently ignores `--all`.
- Stopped containers are kept (not `--rm`) so logs are inspectable post-mortem. `afk gc --local` (manual) or 7-day age sweep cleans them up.
- `--instance-type` and `--on-demand` flags are ignored.

Prerequisites the CLI checks before `--local`: Docker daemon running, AWS credentials present (for SSM dereference), `afk init` already run in this repo.

---

## Source code handling

A Run's image contains the toolchain and dependencies — **not** the source. The entrypoint clones the repo at the configured ref into `/workspace` (inside the main service's container) before executing the dev's command.

Why this split:
- Image rebuilds only when dependencies change (rare).
- Code changes (constant) don't trigger a rebuild — `afk run` is fast.
- The image at a given tag is reproducible from the `afk.Dockerfile` alone.

Two hard rules:
- The working tree must be clean. `afk run` refuses if `git status` is dirty.
- The target ref must be reachable on origin. `afk run` refuses if the current branch (or `--ref`) isn't pushed.

These rules trade convenience for "what runs in the cloud is exactly what's on origin." There is no auto-push, no dirty-tag, no surprise branches.

The same guards make `afk.Dockerfile` and `afk.compose.yml` trustworthy: both are read from the local working tree, and the clean-tree + pushed-ref invariants guarantee they match origin's content at the ref.

---

## Secrets

- Secret values are stored in **SSM Parameter Store SecureString** under `/afk/*`, written by `afk secrets put`.
- Secret *references* (`ssm:/afk/name`) live in `.afk.env`. The CLI passes them to the VM via the `user_data` script, which resolves them at boot using the VM's instance-profile permissions and exports them as environment variables into the compose stack.
- Secret values never appear in `DescribeInstances` output, CloudTrail (beyond the parameter name), or instance tags.
- `.afk.env` is gitignored by default. The CLI refuses to start if `.afk.env` is tracked by git.

The Run needs at minimum a `github-token` secret to clone source.

---

## Attach

`afk attach <run-id>` wraps `aws ssm start-session` against the underlying EC2 instance, then immediately `docker exec`s into the main service's container. Implementation details:

- Uses AWS Systems Manager Session Manager — no inbound networking, no SSH keys.
- The Amazon Linux 2023 Golden Image ships with the SSM agent preinstalled.
- Access is gated by IAM (`ssm:StartSession`) with a tag condition restricting it to Runs the developer owns.
- `--service <name>` exec's into a sidecar instead of the main service.
- `--host` drops to the VM's host shell (no `docker exec`). Useful for debugging compose-graph issues; exposes the Docker socket, so use deliberately.
- Sessions are loggable to CloudWatch / S3 if audit is needed (Terraform variable, off by default).

SSM only. No SSH protocol, no bastion, no inbound ports.

---

## Run lifecycle

- A Run's lifetime equals its main service container's lifetime. When the dev's command exits, compose ends with the main service's exit code, the `user_data` script captures that code, and the VM runs `shutdown -h now`.
- The instance is launched with `InstanceInitiatedShutdownBehavior=terminate`, so OS shutdown causes AWS to terminate the instance. No `ec2:TerminateInstances` permission is granted to the VM itself.
- A wall-clock timeout (default 4h, configurable per-Run and project-wide) wraps the compose invocation with `timeout(1)` — SIGTERM after the cap.
- A sweeper Lambda terminates instances whose agent crashed before reaching `shutdown` (any AFK-managed instance older than its declared timeout, with a grace window).
- The CLI does **not** stay resident after `afk run` returns. The Run lives entirely on EC2. The developer's laptop dying mid-Run has no effect on the Run.

---

## Run state and querying

There is no AFK database. AWS is the source of truth:

- `afk ls` calls `ec2:DescribeInstances` filtered by tags (`afk:owner`, optionally `afk:branch`) and instance-state (`pending`, `running`, `shutting-down`, `stopping`).
- `afk ls --all` drops the owner filter (requires broader IAM).
- EC2 retains terminated instances in `DescribeInstances` for ~1 hour, so very-recently-completed Runs are visible; older history requires reading CloudWatch Logs directly.
- This is intentional. A database can be added later if post-mortem history becomes a real need.

---

## Costs (baseline)

- VPC + IGW: $0.
- No NAT, no VPC endpoints: $0 baseline.
- Sweeper Lambda + EventBridge schedule: effectively $0 (a few invocations per hour).
- Per-Run: EC2 Spot compute (~70% off On-Demand for the same instance type), EBS for the root volume (gp3, ~$0.08/GB-month, only billed while the instance exists), CloudWatch ingest, ECR storage (cycled at 7 days), data egress.
- Spot interruption risk: an interrupted Run dies. Override with `--on-demand` for workloads that can't tolerate this.

---

## Future Backends

The CLI is structured around a `Backend` interface. AWS EC2 is the first implementation. GCP (Compute Engine) and Azure (Virtual Machines) are anticipated; each is expected to follow the same one-VM-per-Run shape, with its own image-build pipeline mapped onto `afk image build` and its own exec primitive mapped onto `afk attach`.

---

## Out of scope for v1

- Notifications on Run completion (no SNS/email/Slack).
- Artifact retrieval beyond logs (agents push their own results — to git, S3, a PR, etc.).
- Multi-region.
- HA NAT / private subnets (single public-subnet AZ topology only).
- Single-binary distribution (Bun runtime required).
- Cost reporting / per-Run accounting.
- Cron / scheduled Runs.
- Warm-pool of pre-booted VMs (cold start is ~60–90s — acceptable for multi-minute workloads).
- GPU and bare-metal instance types (deliberately excluded from the default whitelist).

These are reachable extensions, not architectural changes.
