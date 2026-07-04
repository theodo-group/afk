---
title: Introduction
description: What AFK is, the base-layer model behind it, and why every Backend shares one CLI surface.
---

**AFK** runs ephemeral containerized tasks in the cloud from a CLI. It was built
for AI agents that work while you're AFK ("away from keyboard"), but it works for
any command-runnable workload.

The core unit is a **Run**: one ephemeral execution of a developer-defined
command inside a container in the cloud. A Run starts when its entrypoint command
begins and ends when that command exits. While it's alive you can optionally
attach to observe or intervene — but attach isn't required for a Run to be
useful.

## The one idea

The CLI surface is **identical across Backends**. `afk run`, `afk attach`,
`afk ls`, and `afk kill` mean the same thing whether the work lands on:

- an **EC2 instance** on AWS,
- a **Compute Engine VM** on GCP,
- a **Cloudflare Container instance**, or
- a **Docker container** on your own machine (Local).

Each Run executes on a short-lived **compute primitive** that you own end to
end. Either way the Run has Docker available — the host daemon on AWS/GCP,
rootless `dind` on Cloudflare and Local — so `docker compose up` is the same
surface across providers. That gives an agent first-class access to sidecar
services (Postgres, Redis, etc.) without the limits of serverless container
platforms.

## What this repository is

This repository is the **base layer**. It ships:

- the per-Backend infrastructure (Terraform for AWS and GCP, a launcher Worker
  for Cloudflare),
- the CLI that drives them, and
- the **contract** that consumer repos follow in order to run under AFK.

You install the CLI once, then any repo that provides an `afk.Dockerfile` (and,
optionally, an `afk.compose.yml` and an `afk.config.json`) can launch Runs. See
the [Consumer contract](/reference/consumer-contract/) for the exact files a repo
must provide.

## Where to go next

- **[How it works](/getting-started/how-it-works/)** — the shape every Backend
  follows, from `afk run` to self-termination.
- **[Installation](/getting-started/installation/)** — get the CLI on your PATH
  and satisfy per-Backend prerequisites.
- **[Quickstart](/getting-started/quickstart/)** — stand up your first Run.
- **[Glossary](/concepts/glossary/)** — the canonical vocabulary used throughout
  these docs.
