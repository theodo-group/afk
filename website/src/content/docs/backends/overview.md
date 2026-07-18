---
title: Backends overview
description: The same CLI surface runs on four shipped Backends — AWS EC2, GCP Compute Engine, Cloudflare Containers, and Local — plus an anticipated Azure Backend.
---

A **Backend** is a provider-specific implementation of the operations a Run
depends on: launching a container, attaching an interactive shell, streaming
logs, terminating. The CLI is written against a Backend interface so the
user-facing surface stays identical across providers.

Pick one with `afk init --provider <name>`, or use `--local` per command. Each
Backend's deep detail — what it provisions, its attach / lifecycle / cost
specifics, and teardown — lives in its own page.

| Backend | Compute primitive | Provisioning | Capacity | Retention | Notes |
| --- | --- | --- | --- | --- | --- |
| **[AWS EC2](/afk/backends/aws/)** | One EC2 VM per Run | Terraform (VPC, IAM, sweeper Lambda, DynamoDB, S3 state) | Spot by default; `--on-demand` available | Opt-in (`--retain`, On-Demand only) | Full Compose Contract; host Docker daemon |
| **[GCP Compute Engine](/afk/backends/gcp/)** | One Compute Engine VM per Run | Terraform (VPC + NAT + IAP, service accounts, Firestore, Artifact Registry, GCS state) | Spot by default; `--on-demand` available | Opt-in (`--retain`, On-Demand only) | Full Compose Contract; attach over IAP tunnel |
| **[Cloudflare Containers](/afk/backends/cloudflare/)** | One Container instance per Run | Customer-deployed launcher Worker (rootless `dind`) | n/a | Not possible | Requires the Workers Paid plan |
| **[Local](/afk/backends/local/)** | One container per Run on your own daemon | None (`afk provision` is a no-op) | n/a | Every Run retained | Rootless `dind`; needs only Docker |

**Azure (Virtual Machines)** is anticipated. It is expected to follow the same
one-compute-primitive-per-Run shape as AWS, with its own image-build pipeline
mapped onto `afk golden build` and its own exec primitive mapped onto
`afk attach`.

## What stays the same

No matter the Backend, the backend-neutral commands mean the same thing:

- `afk run <command…>` launches one Run.
- `afk session` launches an [Interactive
  Run](/afk/concepts/glossary/#interactive-run) to attach into and drive by hand.
- `afk ls` lists your Runs (`--all` for team-wide, if permitted).
- `afk attach <run-id>` drops you into the main service (or a sidecar with
  `--service`, or the host with `--host`).
- `afk logs <run-id>` tails logs from the active Backend's log store.
- `afk kill <run-id>` terminates the Run's compute primitive.

See the [CLI surface](/afk/reference/cli/) for the complete command reference.
