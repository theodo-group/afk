# AFK

Run ephemeral containerized tasks in the cloud from a CLI. Built for AI agents that work while you're AFK ("away from keyboard"), but works for any cli-runnable workload.

This repository is the **base layer**: it ships the Terraform that provisions the cloud infra, the CLI that drives it, and the contract that consumers must follow in their own repos.

---

## Concepts

See [`CONTEXT.md`](./CONTEXT.md) for the canonical glossary. Quick orientation:

- **Run** — one ephemeral execution of a developer-defined command inside a container in the cloud. Backed by exactly one ECS Task. May be observed via attach but does not require it.
- **Backend** — cloud-provider implementation. AWS ECS first; GCP (GKE Autopilot) and Azure (Container Instances / Container Apps) anticipated.
- **Owner** — the IAM principal that launched a Run. Used for access control.
- **Dockerfile Contract** — the rules a consumer's `afk.Dockerfile` must follow.
- **Ref** — the git reference a Run executes against.

---

## How it works (end-to-end)

1. Developer runs `afk init --provider aws` in their repo once. CLI creates the Terraform state S3 bucket, copies the matching Backend Terraform module into their repo (`terraform/aws/` → consumer's `terraform/afk/`), scaffolds `.afk.env` and `afk.config.json` (with `backend: "aws"`), gitignores `.afk.env`. `--provider` defaults to `aws` while it is the only supported Backend.
2. Developer runs `terraform apply` from `terraform/afk/`. This creates the VPC, Fargate cluster, IAM roles and policies, and the developer IAM role.
3. Developer stores their GitHub Personal Access Token: `afk secrets put github-token <PAT>`.
4. Developer runs `afk run "claude -p 'fix the failing tests'"`. The CLI:
   - Refuses if the working tree is dirty or the current branch isn't pushed to origin.
   - Builds the Docker image if no image exists for `<branch>-<sha>` in ECR (otherwise skips). The build runs `docker build -f afk.Dockerfile .` and wraps the dev's `afk.Dockerfile` with a CLI-owned entrypoint.
   - Pushes the image to the ECR repository `afk/<source-repo>` (creating it lazily with a 7-day lifecycle if absent).
   - Registers a fresh ECS Task Definition with the image, env vars, SSM secret references, CPU/memory, and IAM task role.
   - Calls `ecs:RunTask` on the shared cluster, tagged `afk:owner=<principal>`, `afk:run-id=<id>`, `afk:branch=<branch>`, `afk:sha=<sha>`.
   - Returns the Run ID and exits.
5. The container boots. The CLI-injected entrypoint reads `AFK_GIT_URL`, `AFK_GIT_REF`, and the GitHub token, clones the repo at the ref into `/workspace`, then `exec`s the dev's command under a wall-clock timeout (default 4h).
6. Developer optionally attaches: `afk attach <run-id>` opens an interactive shell into the container via ECS Exec.
7. The agent does its work (typically pushing results to a branch, opening a PR, or whatever the agent is wired to do). Stdout/stderr stream to CloudWatch Logs under `/afk/<source-repo>` (30-day retention).
8. The entrypoint exits → ECS Task ends → the CLI deregisters the Task Definition revision (best-effort; sweeper covers crashes).
9. Developer reads results: `afk logs <run-id>` or wherever the agent published its output.

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
│   └── aws/                # AWS Backend — ECS Fargate (only Backend supported in v1)
│       ├── main.tf
│       ├── vpc.tf
│       ├── ecs.tf
│       ├── iam.tf
│       ├── variables.tf
│       └── outputs.tf
│   # future: gcp/, azure/
├── entrypoint/             # CLI-injected container entrypoint
│   └── entrypoint.sh
├── docs/
│   └── adr/                # architecture decision records (added as decisions warrant)
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
- **Does not declare `ENTRYPOINT`.** The CLI injects one at build time by materializing a wrapper Dockerfile (`FROM <dev's image>` + `COPY entrypoint.sh /afk/entrypoint.sh` + `ENTRYPOINT [...]`).
- Leaves `/workspace` writable. The entrypoint will clone source there.

Example:

```dockerfile
FROM node:20
RUN apt-get update && apt-get install -y git
RUN npm install -g @anthropic-ai/claude-code
WORKDIR /workspace
```

### 2. `afk.config.json`

```json
{
  "backend": "aws",
  "gitUrl": "https://github.com/you/your-repo.git",
  "defaultCpu": 1024,
  "defaultMemory": 2048,
  "defaultTimeoutHours": 4
}
```

`backend` and `gitUrl` are required. `backend` selects which Backend implementation drives the CLI (`aws` is the only choice in v1; `gcp` and `azure` are anticipated). Set once by `afk init --provider <name>`; subsequent commands read it from the config and dispatch automatically — no per-command `--backend` flag needed. Resource defaults are optional.

Backend-specific knobs, when they exist, are namespaced under the backend name (e.g. `"aws": { "region": "us-east-1" }`). Most runtime values the CLI needs (cluster name, subnet IDs, role ARNs) are read from `terraform output -json`, not from this file.

### 3. `.afk.env` (gitignored)

Contains environment variables for Runs. Values may be plain strings (for non-secrets) or SSM references (for secrets). Pure references → `.afk.env` is safe to commit if desired, but it is gitignored by default.

```
LOG_LEVEL=debug
ANTHROPIC_API_KEY=ssm:/afk/anthropic-key
DATABASE_URL=ssm:/afk/db-url
```

Secrets themselves are stored separately via `afk secrets put <name> <value>` (writes to SSM Parameter Store SecureString) and referenced from `.afk.env`.

---

## CLI surface

```
afk init [--provider aws|gcp|azure]       # one-time setup in a repo; selects Backend (default aws)
afk doctor                                # check dependencies and AWS credentials
afk config                                # print resolved config (debug)

afk build [--ref <ref>] [--local]         # explicit build + push (afk run also builds if needed)
afk run <command…>                        # launch a Run
  --ref <branch|sha|tag>                  #   defaults to current local branch
  --cpu <units>                           #   overrides project default (ignored when --local)
  --memory <mb>                           #   overrides project default (ignored when --local)
  --timeout <hours>                       #   overrides default (4h)
  --detach / -d                           #   default: launch and exit; without -d, streams logs
  --local                                 #   use the Local Backend (Docker on this machine) for this invocation
afk ls [--all] [--status <s>] [--local]   # list Runs (yours by default; --all = team-wide if permitted)
afk attach <run-id> [--local]             # interactive shell (ECS Exec, or `docker exec` when --local)
afk logs <run-id> [--follow] [--local]    # tail logs (CloudWatch, or `docker logs` when --local)
afk kill <run-id> [--local]               # stop a Run
afk gc [--local]                          # prune stopped containers older than 7d (Local only; cloud is auto-reaped)

afk secrets put <name> [value]            # write to SSM (prompts if value omitted)
afk secrets ls                            # list stored secret names
afk secrets rm <name>                     # delete from SSM

afk team add <name> [--principal <arn>]   # admin: provision a developer (IAM user or trusted principal)
afk team ls                               # admin: list members
afk team rm <name>                        # admin: revoke access

# Global flags
--json                                    # machine-readable JSON output
--verbose / -v                            # debug logging
--quiet / -q                              # errors only
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
- ECS Tasks launch with `assignPublicIp=ENABLED`. Inbound is unreachable; outbound goes direct.

### Compute

- One Fargate ECS cluster (`afk-cluster`).
- No long-running services. Task Definitions are registered per Run by the CLI and deregistered on completion.

### Identity

- An `afk-task-execution` role (used by ECS to pull from ECR, read SSM secrets, write to CloudWatch).
- An `afk-task` role (used by the container at runtime — minimal, can be extended by consumers for app-specific permissions).
- An `afk-developer` role + policy. The policy grants:
  - `ecs:RunTask`, `ecs:RegisterTaskDefinition`, `ecs:DeregisterTaskDefinition`, `ecs:ListTasks`, `ecs:DescribeTasks`, `ecs:StopTask` on the AFK cluster.
  - `ecs:ExecuteCommand` conditioned on `aws:ResourceTag/afk:owner == aws:userid` (developers can only attach to their own Runs).
  - `ecr:*` scoped to repositories prefixed `afk/*`.
  - `ssm:PutParameter`, `ssm:GetParameter`, `ssm:DeleteParameter` scoped to `/afk/*`.
  - `logs:CreateLogGroup`, `logs:PutRetentionPolicy`, `logs:GetLogEvents` scoped to `/afk/*`.
- An admin attaches `afk-developer` to whichever IAM users/roles should have access.

### Storage / state

- The Terraform state itself lives in an S3 bucket created by `afk init` (not by Terraform — chicken-and-egg). S3 native state locking (`use_lockfile = true`) replaces the older DynamoDB pattern.

### Not created by Terraform

- **ECR repositories** are created lazily by the CLI on first `afk build` for a given source repo, with a 7-day untagged-image lifecycle policy applied at creation. The Terraform grants the permission scope only.
- **CloudWatch log groups** (`/afk/<source-repo>`) are created lazily by the CLI with 30-day retention.

---

## Local Backend

Every command accepts `--local` to execute against the developer's local Docker daemon instead of the configured cloud Backend. The point is faithful rehearsal: same image build, same CLI-injected entrypoint, same `.afk.env` resolution (including `ssm:` references, which the CLI dereferences client-side via `ssm:GetParameter`), same wall-clock timeout, same git-clone-from-origin source handling.

What is the same as cloud:
- Dirty-tree and unpushed-ref refusal — Local enforces both, identical to cloud.
- Image build pipeline — wrapper Dockerfile, CLI-injected entrypoint, same tag format (`afk/<repo>:<branch>-<sha>`). Image stays in the local Docker daemon; no ECR push.
- Secret resolution — `ssm:` references in `.afk.env` are fetched from SSM by the CLI and passed as `-e KEY=VALUE` to `docker run`.
- Lifecycle — entrypoint clones source at the configured ref, executes the command under a `timeout(1)` wrapper, exits.

What differs from cloud:
- No ECR push, no ECS Task Definition registration, no ECS Exec. Containers carry labels (`afk.managed=true`, `afk.run-id=<id>`, `afk.repo=<repo>`, `afk.ref=<sha>`) so `afk ls --local`, `afk attach --local`, etc. can find them via `docker ps --filter`.
- `afk attach --local` uses `docker exec -it`; `afk logs --local` uses `docker logs -f`; `afk kill --local` uses `docker stop` + `docker rm`.
- No owner tag — your machine, one user. `afk ls --all --local` silently ignores `--all`.
- Stopped containers are kept (not `--rm`) so logs are inspectable post-mortem. `afk gc --local` (manual) or 7-day age sweep cleans them up.
- `--cpu`/`--memory` flags are ignored (Docker on a dev laptop is sized by the laptop).

Prerequisites the CLI checks before `--local`: Docker daemon running, AWS credentials present (for SSM dereference), `afk init` already run in this repo.

---

## Source code handling

A Run's image contains the toolchain and dependencies — **not** the source. The entrypoint clones the repo at the configured ref into `/workspace` before executing the dev's command.

Why this split:
- Image rebuilds only when dependencies change (rare).
- Code changes (constant) don't trigger a rebuild — `afk run` is fast.
- The image at a given tag is reproducible from the `afk.Dockerfile` alone.

Two hard rules:
- The working tree must be clean. `afk run` refuses if `git status` is dirty.
- The target ref must be reachable on origin. `afk run` refuses if the current branch (or `--ref`) isn't pushed.

These rules trade convenience for "what runs in the cloud is exactly what's on origin." There is no auto-push, no dirty-tag, no surprise branches.

---

## Secrets

- Secret values are stored in **SSM Parameter Store SecureString** under `/afk/*`, written by `afk secrets put`.
- Secret *references* (`ssm:/afk/name`) live in `.afk.env`. The CLI parses these and wires them into the Task Definition's `containerDefinitions.secrets`, which AWS injects as environment variables in the container at task start.
- Secret values never appear in `ecs:DescribeTasks` output, CloudTrail, or environment overrides.
- `.afk.env` is gitignored by default. The CLI refuses to start if `.afk.env` is tracked by git.

The Run needs at minimum a `github-token` secret to clone source.

---

## Attach

`afk attach <run-id>` wraps `aws ecs execute-command --interactive --command /bin/bash` against the underlying ECS Task. Implementation details:

- Uses AWS Systems Manager Session Manager under the hood — no inbound networking, no SSH keys.
- The Fargate platform includes the SSM agent; the consumer's `afk.Dockerfile` needs no special setup.
- Access is gated by IAM (`ecs:ExecuteCommand`) with a tag condition restricting it to Runs the developer owns.
- Sessions are loggable to CloudWatch / S3 if audit is needed (Terraform variable, off by default).

ECS Exec only. No SSH protocol, no bastion, no inbound ports.

---

## Run lifecycle

- A Run's lifetime equals its entrypoint's lifetime. When the dev's command exits, the entrypoint exits, and the ECS Task ends.
- A wall-clock timeout (default 4h, configurable per-Run and project-wide) wraps the entrypoint with `timeout(1)` — SIGTERM after the cap.
- The CLI does **not** stay resident after `afk run` returns. The Run lives entirely in ECS. The developer's laptop dying mid-Run has no effect on the Run.
- On the CLI's machine: best-effort `ecs:DeregisterTaskDefinition` after the Run ends. ECS task-definition revisions are free but accumulate; deregistration keeps the console clean.

---

## Run state and querying

There is no AFK database. AWS is the source of truth:

- `afk ls` calls `ecs:ListTasks` against the AFK cluster, filtered by tags (`afk:owner`, optionally `afk:branch`).
- `afk ls --all` drops the owner filter (requires broader IAM).
- ECS retains stopped tasks for ~1 hour, so very-recently-completed Runs are visible; older history requires reading CloudWatch Logs directly.
- This is intentional. A database can be added later if post-mortem history becomes a real need.

---

## Costs (baseline)

- VPC + IGW: $0.
- No NAT, no VPC endpoints: $0 baseline.
- ECS Cluster: $0 (Fargate is per-task).
- Per-Run: Fargate compute (~$0.04/vCPU-hr + $0.004/GB-hr), CloudWatch ingest, ECR storage (cycled at 7 days), data egress.

---

## Future Backends

The CLI is structured around a `Backend` interface. AWS ECS is the first implementation. GCP (GKE Autopilot) and Azure (Container Instances / Container Apps) are anticipated; each has a native exec primitive equivalent to ECS Exec. No Backend code beyond ECS exists yet.

---

## Out of scope for v1

- Notifications on Run completion (no SNS/email/Slack).
- Artifact retrieval beyond logs (agents push their own results — to git, S3, a PR, etc.).
- Multi-region.
- HA NAT / private subnets (single public-subnet AZ topology only).
- Single-binary distribution (Bun runtime required).
- Cost reporting / per-Run accounting.
- Cron / scheduled Runs.

These are reachable extensions, not architectural changes.
