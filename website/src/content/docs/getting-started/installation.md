---
title: Installation
description: Install the AFK CLI via clone + bun link, and satisfy the prerequisites for each Backend.
---

AFK is **not published to a registry**. You consume it by cloning the repo and
linking the CLI globally.

```sh
git clone https://github.com/theodo-group/afk.git ~/afk
cd ~/afk/cli
bun install
bun link              # registers @afk/cli globally
```

`bun link` puts a symlink at `~/.bun/bin/afk` that resolves back to this
checkout. If `~/.bun/bin` is on your `PATH` (Bun's installer adds it by
default), `afk` is now usable from any project. Editing the source in your
checkout takes effect immediately — no relink needed.

:::tip[afk not found?]
Common when Bun was installed via Homebrew or another package manager. Add
`~/.bun/bin` to your shell `PATH` — e.g. `export PATH="$HOME/.bun/bin:$PATH"`
in `~/.bashrc` / `~/.zshrc`, or `set PATH $PATH ~/.bun/bin` in
`~/.config/fish/config.fish`.
:::

Updating: `git pull && bun install`. There is no version pinning; you run
whatever sha you checked out.

## Prerequisites

### On every developer machine

- **Bun** (runtime)
- **Docker** (image builds)
- A working **`git` credential helper** that can read your remote
  (`gh auth setup-git` is the easiest if you have the GitHub CLI installed)

### For the AWS Backend

- **Terraform ≥ 1.10** (for S3 native state locking)
- **AWS CLI** (credential chain) with creds for the target account
- **`session-manager-plugin`** (required for `afk attach`)
- **`npm`** (the sweeper Lambda is bundled with esbuild at `terraform apply`
  time)

### For the GCP Backend

- **Terraform ≥ 1.10** (GCS native state locking)
- **`gcloud` CLI** authenticated (`gcloud auth login`); the active account is
  the Run's Owner
- A **GCP project** with billing enabled, selected via
  `gcloud config set project <id>`
- **OS Login + IAP TCP forwarding** (`roles/iap.tunnelResourceAccessor`, granted
  by the module) for `afk attach` — no public IP, no SSH

### For the Cloudflare Backend

- **`wrangler`** (Cloudflare's deploy CLI) on PATH
- **`CLOUDFLARE_API_TOKEN`** in a gitignored `.env` at the repo root (afk
  auto-loads `.env`), scoped for `Workers Scripts:Edit`,
  `Workers Containers:Edit`, `Cloudflare Images:Edit`, `D1:Edit`,
  `Workers KV Storage:Edit`, and `Access: Service Tokens:Edit` (the last only
  for `afk team add`)
- A Cloudflare account on the **Workers Paid plan** (Containers requires it)

### For the Local Backend

Just Docker. Nested `dind` requires the outer container to run `--privileged`,
so a Docker daemon that permits privileged containers is needed.
