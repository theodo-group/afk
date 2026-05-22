# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

AFK is a system for running ephemeral containerized tasks (typically AI agents) in the cloud from a CLI. This repository is the **base layer** — it ships the Terraform that consumers copy into their own repos, the entrypoint that gets injected into consumer images, and (eventually) the CLI.

Read `README.md` end-to-end and `CONTEXT.md` for the canonical glossary before changing anything substantive. The README is the spec; the code under `terraform/` and `entrypoint/` implements parts of it.

## Current state vs. README

The README describes the full v1 surface, but only some of it exists today:

- `terraform/aws/` — AWS Backend module. Complete and the only Backend.
- `entrypoint/entrypoint.sh` — CLI-injected container entrypoint. Complete.
- `cli/` — **not yet implemented** despite being described in the README. TypeScript + Bun is the planned stack (`bun install`, `bun link`).
- `examples/`, `docs/adr/` — referenced in README but do not exist yet.

When asked to implement CLI surface, treat the README's "CLI surface" section as the spec and the entrypoint env-var contract as the integration point.

## Architecture you must internalize

The split that drives every design choice:

1. **Image = toolchain only**, no source. Built rarely, keyed by `<branch>-<sha>` in ECR per consumer repo.
2. **Source = cloned at Run start** by the injected entrypoint into `/workspace`, using a short-lived GitHub PAT from SSM.
3. **CLI builds a wrapper Dockerfile** at build time: `FROM <dev's image>` + `COPY entrypoint.sh` + `ENTRYPOINT [...]`. The consumer's Dockerfile must not declare `ENTRYPOINT` or `COPY` source — this is the Dockerfile Contract.
4. **No long-running services.** Each `afk run` registers a fresh Task Definition, calls `ecs:RunTask`, returns. The CLI is not resident after launch.
5. **AWS is the source of truth.** No AFK database. `afk ls` is `ecs:ListTasks` filtered by `afk:owner` / `afk:branch` tags.

## Entrypoint contract (`entrypoint/entrypoint.sh`)

The contract any caller (i.e. the future CLI's ECS Task Definition) must satisfy:

- **Required env:** `AFK_GIT_URL`, `AFK_GIT_REF`, `GITHUB_TOKEN`.
- **Optional env:** `AFK_GIT_SHA` (verified against resolved HEAD), `AFK_TIMEOUT_SECONDS` (default 14400 = 4h), `AFK_RUN_ID`, `AFK_WORKSPACE` (default `/workspace`).
- **Args:** the developer's command, `exec`'d under `timeout --foreground --kill-after=30s`.
- **Exit codes:** `64` missing env, `65` clone/checkout failed, `66` SHA mismatch, `124` timeout, otherwise the developer command's own exit code.
- After clone, `GITHUB_TOKEN` is unset and `git remote set-url origin` is rewritten to the un-authenticated URL, so the dev's command cannot leak the token via `git remote -v`.

## Terraform module (`terraform/aws/`)

The module is **copied into consumer repos by `afk init`**, not consumed as a remote module. Keep it self-contained (no remote module dependencies, no external data sources beyond AWS).

Resource ownership split — this is intentional and load-bearing:

- **Terraform creates:** VPC + 2 public subnets + IGW (no NAT), Fargate cluster, security group (deny inbound, allow all outbound), and three IAM roles (`afk-task-execution`, `afk-task`, `afk-developer`) + the customer-managed `afk-developer` policy.
- **CLI creates lazily at runtime:** ECR repositories under `afk/*` (with a 7-day untagged lifecycle), CloudWatch log groups under `/afk/*` (with 30-day retention), Task Definition revisions per Run.
- **Terraform state bucket** is created by `afk init`, not Terraform itself (chicken-and-egg). The backend uses S3 native locking (`use_lockfile = true`), not DynamoDB. Requires Terraform ≥ 1.10.

IAM resource ARNs in `iam.tf` use `${var.project_name}/*` prefixes (e.g. `arn:aws:ecr:...:repository/afk/*`, `parameter/afk/*`, `log-group:/afk/*`). Anything new the CLI creates at runtime must live under those prefixes or the developer role will reject it.

The `aws:ResourceTag/afk:owner == ${aws:userid}` condition on `ecs:ExecuteCommand` is what restricts `afk attach` to a developer's own Runs. Don't weaken it.

## Conventions

- **Secrets:** plain values go in `.afk.env`; SSM references use the `ssm:/afk/<name>` form and resolve via `containerDefinitions.secrets` in the Task Definition. `.afk.env` is gitignored; the CLI must refuse to start if it's tracked.
- **Tagging:** every Run gets `afk:owner`, `afk:run-id`, `afk:branch`, `afk:sha`. These are the only way to query Run state.
- **Refs:** `afk run` refuses if the working tree is dirty or the resolved ref isn't reachable on origin. No dirty-tag, no auto-push.
- **Backend abstraction:** AWS ECS is the first Backend. The README anticipates GCP and Azure Backends — when adding interfaces, design against the `Backend` boundary, don't bake ECS-specific terms into user-facing CLI code.

## Out of scope for v1

Notifications, artifact retrieval beyond logs, multi-region, private subnets / HA NAT, single-binary distribution, cost reporting, scheduled Runs. Listed in README "Out of scope" — don't volunteer these.
