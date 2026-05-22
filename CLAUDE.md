# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

The spec lives in `README.md`; the glossary in `CONTEXT.md`. Read both before substantive changes.

## State of the repo

- `terraform/aws/` — AWS Backend module. Complete.
- `entrypoint/entrypoint.sh` — container entrypoint injected by the CLI. Complete. Env-var contract documented at the top of the file.
- `cli/` — **not implemented yet** (README describes it: TypeScript + Bun). When building it, treat README's "CLI surface" as the spec.
- `examples/`, `docs/adr/` — referenced in README, do not exist yet.

## Load-bearing invariants

- **Image = toolchain only; source is cloned at Run start** into `/workspace` by `entrypoint.sh`. The CLI wraps the dev's Dockerfile (`FROM` + `COPY entrypoint.sh` + `ENTRYPOINT`) — dev Dockerfiles must not declare `ENTRYPOINT` or `COPY` source.
- **No long-running services.** `afk run` registers a Task Definition, calls `ecs:RunTask`, exits.
- **AWS is the source of truth** (no AFK database). Runs are queried via `ecs:ListTasks` + the `afk:owner` / `afk:run-id` / `afk:branch` / `afk:sha` tags.
- **Resource ownership split:** Terraform creates VPC + cluster + SG + IAM. The CLI lazily creates ECR repos and log groups under the `afk/*` prefix at runtime — IAM ARNs in `terraform/aws/iam.tf` are scoped to that prefix, so new runtime-created resources must stay under it.
- **Attach is gated by `aws:ResourceTag/afk:owner == ${aws:userid}`** on `ecs:ExecuteCommand` (see `iam.tf`). Don't weaken.
- **Terraform module is copied into consumer repos by `afk init`**, not consumed as a remote module — keep it self-contained.
- **State backend:** S3 + `use_lockfile = true` (no DynamoDB). Requires Terraform ≥ 1.10. The state bucket is created by `afk init`, not by Terraform.

## Conventions

- Secrets: `ssm:/afk/<name>` references in `.afk.env` (gitignored); wired via `containerDefinitions.secrets`.
- `afk run` refuses on dirty tree or unreachable-on-origin ref. No auto-push.
- Design CLI code against a `Backend` interface — ECS is first of several anticipated Backends.

## Out of scope for v1

See README "Out of scope". Don't volunteer notifications, multi-region, private subnets, cron, single-binary distribution, etc.
