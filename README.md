# AFK

Run ephemeral containerized tasks in the cloud from a CLI. Built for AI agents that work while you're AFK ("away from keyboard"), but works for any cli-runnable workload.

```sh
# In any repo with an afk.Dockerfile — no cloud account, just Docker:
afk init --provider local                                  # configure (writes backend=local)
afk golden build                                           # one-time: build the local runtime image
afk run "claude -p 'fix the failing test and open a PR'"   # launch an agent in a container
afk ls                                                     # see it running
afk logs <run-id>                                          # tail its output
```

That Run executes on your own Docker daemon. Point the same project at a cloud Backend (AWS, GCP, or Cloudflare) and the _identical_ commands launch the work on ephemeral cloud compute instead — see [Quickstart](#quickstart).

---

## Why AFK

Each Run executes on a short-lived **compute primitive** that the developer owns end-to-end — an EC2 VM on the AWS Backend, a Compute Engine VM on the GCP Backend, a Cloudflare Container instance on the Cloudflare Backend. Either way the Run has Docker available (the host daemon on AWS/GCP, rootless `dind` on Cloudflare), so `docker compose up` is the same surface across providers — giving the agent first-class access to sidecar services (Postgres, Redis, etc.) without the limitations of serverless container platforms.

This repository is the **base layer**: it ships the per-Backend infra (Terraform for AWS and GCP, a launcher Worker for Cloudflare), the CLI that drives them, and the contract that consumers must follow in their own repos.

---

## How it works

Every backend follows the same shape. `afk run`:

1. Refuses if the working tree is dirty or the ref isn't pushed to origin.
2. Builds your `afk.Dockerfile` into an agent image, wrapped with a CLI-owned entrypoint (skipped if the `<branch>-<sha>` image already exists).
3. Launches **one compute primitive** for the Run — an EC2 VM on AWS, a Compute Engine VM on GCP, a Container instance on Cloudflare, a local `dind` container on Local — booted from the project's [Golden Image](#concepts).
4. That primitive clones your repo at the ref into `/workspace`, then runs your command — under `docker compose up` if you have an `afk.compose.yml`, else `docker run` — inside a wall-clock timeout, shipping each service's logs.
5. On exit the primitive is reclaimed. The CLI does **not** stay resident; the Run lives on the primitive, so a dead laptop doesn't affect it.

The per-backend specifics (how the primitive is launched, provisioned, attached to, and torn down) live in [the backend docs](#backends). For a concrete walkthrough see the [AWS end-to-end flow](./docs/backends/aws.md#end-to-end-flow).

---

## Source code handling

A Run's image contains the toolchain and dependencies — **not** the source. The entrypoint clones the repo at the configured ref into `/workspace` (inside the main service's container) before executing the dev's command. On Cloudflare and Local the clone runs the same way, inside the rootless `dind`.

Why this split:

- Image rebuilds only when dependencies change (rare).
- Code changes (constant) don't trigger a rebuild — `afk run` is fast.
- The image at a given tag is reproducible from the `afk.Dockerfile` alone.

This is why step 1 above refuses to launch unless the working tree is clean and the ref is pushed to origin: it buys the invariant that **what runs in the cloud is exactly what's on origin** — no auto-push, no dirty-tag, no surprise branches. The same guards make `afk.Dockerfile` and `afk.compose.yml` trustworthy: both are read from the local working tree, and clean-tree + pushed-ref guarantee they match origin's content at the ref.

---

## Install

This repo is **not published to a registry**. Developers consume it by cloning.

```sh
git clone <this-repo> ~/afk
cd ~/afk/cli
bun install
bun link              # registers @afk/cli globally
```

`bun link` puts a symlink at `~/.bun/bin/afk` that resolves back to this checkout. If `~/.bun/bin` is on your PATH (Bun's installer adds it by default), `afk` is now usable from any project. Editing the source in your checkout takes effect immediately — no relink needed.

> If `afk` isn't found after `bun link` (common when Bun was installed via Homebrew or another package manager), add `~/.bun/bin` to your shell `PATH` — e.g. `export PATH="$HOME/.bun/bin:$PATH"` in `~/.bashrc` / `~/.zshrc`, or `set PATH $PATH ~/.bun/bin` in `~/.config/fish/config.fish`.

Prerequisites on the developer machine:

- Bun (runtime)
- Docker (image builds)
- A working `git` credential helper that can read your private remote (`gh auth setup-git` is the easiest if you have the GitHub CLI installed)

For the **AWS Backend** additionally:

- Terraform ≥ 1.10 (for S3 native state locking)
- AWS CLI (credential chain) with creds for the target account
- `session-manager-plugin` (required for `afk attach`)
- `npm` (the sweeper Lambda is bundled with esbuild at `terraform apply` time)

For the **GCP Backend** additionally:

- Terraform ≥ 1.10 (GCS native state locking)
- `gcloud` CLI authenticated (`gcloud auth login`); the active account is the Run's Owner
- A GCP project with billing enabled, selected via `gcloud config set project <id>`
- OS Login + IAP TCP forwarding (`roles/iap.tunnelResourceAccessor`, granted by the module) for `afk attach` — no public IP, no SSH

For the **Cloudflare Backend** additionally:

- `wrangler` (Cloudflare's deploy CLI) on PATH
- `CLOUDFLARE_API_TOKEN` in a gitignored `.env` at the repo root (afk auto-loads `.env`), scoped for `Workers Scripts:Edit`, `Workers Containers:Edit`, `Cloudflare Images:Edit`, `D1:Edit`, `Workers KV Storage:Edit`, and `Access: Service Tokens:Edit` (the last only for `afk team add`)
- A Cloudflare account on the Workers Paid plan (Containers requires it)

Updates: `git pull && bun install`. There is no version pinning; consumers run whatever sha they checked out.

---

## Quickstart

Pick a Backend; the CLI surface is identical from there. Local (above) needs only Docker and zero cloud setup — add a `github-token` secret so Runs can clone source:

```sh
afk secrets put github-token <PAT>            # stored under ~/.afk/secrets/, keyed by gitUrl
echo "GITHUB_TOKEN=secret:github-token" >> .afk.env
```

Already configured for a cloud Backend? Add `--local` to any command to rehearse a Run on your own daemon (after a one-time `afk golden build --local`). Teardown is manual — see the [Local backend doc](./docs/backends/local.md).

### Quickstart on AWS

In a fresh consumer repo:

```sh
afk init --provider aws --region eu-west-1   # creates the state bucket + scaffolds files
afk provision                                # terraform apply: VPC, IAM, sweeper Lambda, DynamoDB
afk golden build                             # one-time per account/region (~5 min)
afk secrets put github-token <PAT>           # a GitHub PAT so the VM can clone source
echo "GITHUB_TOKEN=secret:github-token" >> .afk.env

# Author + push your contract files (afk.Dockerfile, optional afk.compose.yml — see below).
git add afk.Dockerfile afk.compose.yml afk.config.json && git commit -m "configure AFK" && git push
afk run bun --version
afk ls && afk logs <run-id>
```

Teardown: `afk destroy` (dry-run) / `afk destroy --yes`. See the [AWS backend doc](./docs/backends/aws.md#teardown) for exactly what is removed.

### Quickstart on GCP

> **Same one-VM-per-Run shape as AWS** — a Compute Engine instance per Run, booted from a custom-image Golden Image, self-deleted on exit. Differences: attach rides an IAP TCP tunnel (no public IP, no SSH) and the Owner is your authenticated gcloud account. Skim the [GCP backend doc](./docs/backends/gcp.md) for topology and auth before your first deploy.

In a fresh consumer repo (after `gcloud auth login` and `gcloud config set project <id>`):

```sh
afk init --provider gcp --region us-central1  # resolves the project, creates the GCS state bucket + scaffolds files
afk provision                                 # terraform apply: APIs, VPC + NAT + IAP firewall, SAs, Firestore, Artifact Registry, reconcile Cloud Function
afk golden build                              # one-time per project (~5 min): snapshots a builder VM into a custom image
afk secrets put github-token <PAT>            # a GitHub PAT (Secret Manager) so the VM can clone source
echo "GITHUB_TOKEN=secret:github-token" >> .afk.env

# Author + push your contract files (same as AWS), then launch.
git add afk.Dockerfile afk.compose.yml afk.config.json && git commit -m "configure AFK" && git push
afk run bun --version                         # Spot capacity by default; --on-demand for interruption-resistance
afk ls && afk logs <run-id>
```

Teardown: `afk destroy` (dry-run) / `afk destroy --yes`. See the [GCP backend doc](./docs/backends/gcp.md#teardown) for exactly what is removed.

### Quickstart on Cloudflare

> **Read first:** the CF Backend uses **rootless Docker-in-Docker** inside one Container instance per Run, gated by a customer-deployed **launcher Worker**. Different topology from AWS; same `afk` CLI surface. If this is your first CF deploy, skim the [Cloudflare backend doc](./docs/backends/cloudflare.md) (topology, auth boundaries, limitations) before starting.

In a fresh consumer repo:

Prerequisites: a Workers Paid plan, `wrangler` on PATH, and a `CLOUDFLARE_API_TOKEN` in a gitignored `.env` (scopes under [Install](#install); afk auto-loads `.env`).

```sh
echo 'CLOUDFLARE_API_TOKEN=<your-token>' >> .env
afk init --provider cloudflare   # scaffold worker/afk/, merge a cloudflare: config block
afk golden build                 # build + push the Golden Container image
afk provision                    # create D1+KV, migrate, deploy the Worker, set CF_API_TOKEN
afk doctor                       # verify wrangler, token, worker reachability, golden image
afk secrets put github-token <PAT>            # stored as a Workers Secret
echo "GITHUB_TOKEN=secret:github-token" >> .afk.env

# Author + push your contract files (same as AWS), then launch.
git add afk.Dockerfile afk.compose.yml afk.config.json worker/afk && git commit -m "configure AFK" && git push
afk run bun --version
afk ls && afk logs <run-id>
```

> **Auth note.** The CLI authenticates to the launcher Worker with Cloudflare Access service-token headers, or a shared bearer (`AFK_SHARED_TOKEN`) for single-dev mode. Production deploys should wrap the Worker URL in a Cloudflare Access application and use `afk team add`. Full detail is in the [Cloudflare backend doc](./docs/backends/cloudflare.md).

Teardown: `afk destroy --yes` (golden images, launcher Worker + DOs, Container app, D1, KV). See the [Cloudflare backend doc](./docs/backends/cloudflare.md#teardown) and [`worker/cloudflare/README.md`](./worker/cloudflare/README.md) for internals.

---

## CLI surface

Every command also responds to `afk <command> --help`. The full surface:

```
afk init [--provider <aws|gcp|cloudflare|local>] [--region <region>]
                                               # one-time setup in a repo (scaffolds config + Backend infra)
                                               # --provider defaults to aws; --region applies to provider=aws|gcp
                                               # GCP: resolves the project from active gcloud config, creates the GCS state bucket
                                               # CF: derives accountId from the token and merges the cloudflare config block
                                               # local: writes backend=local + a local config block (no cloud infra)
afk provision                                  # stand up the active Backend's infra (idempotent)
                                               #   AWS:   terraform init && apply (VPC, IAM, sweeper Lambda, DynamoDB)
                                               #   GCP:   terraform apply (APIs, VPC+NAT+IAP, SAs, Firestore, Artifact Registry, reconcile Cloud Function)
                                               #   CF:    create D1+KV, migrate, deploy the launcher Worker, set
                                               #          CF_API_TOKEN, write workerUrl (run after `afk golden build`)
                                               #   local: no-op (nothing to stand up)
afk doctor                                     # check dependencies, Backend creds, Golden Image presence + age
afk config                                     # print resolved config (debug)

afk golden build                               # build the Golden Image for the active Backend
                                               #   AWS: an AMI tagged afk:golden=true
                                               #   GCP: a GCE custom image labelled afk-golden=true
                                               #   CF:  a Container image in the CF managed registry
afk golden ls                                  # list Golden Images for the active Backend
afk golden rm <id-or-tag>                      # delete a Golden Image

afk build [--ref <ref>]                        # explicit container image build + push (afk run also builds if needed)
afk run <command…>                             # launch a Run
  --ref <branch|sha|tag>                       #   defaults to current local branch
  --instance-type <type>                       #   AWS/GCP: overrides project default EC2 instance type / GCE machine type
  --on-demand                                  #   AWS/GCP: on-demand capacity (pricier, not preemptible; Spot by default)
  --instance-tier <tier>                       #   CF only: overrides project default CF Containers tier
  --timeout <hours>                            #   overrides default (4h)
  --follow / -f                                #   stream logs until the Run ends (default: launch and exit)
afk ls [--all] [--status <s>]                  # list Runs (yours by default; --all = team-wide if permitted)
afk attach <run-id> [--service <name>] [--host]
                                               # interactive shell. Default: docker exec into main service.
                                               # --service <name>: attach to a sidecar instead.
                                               # --host:           drop to the Run's compute-primitive host shell.
afk logs <run-id> [--follow] [--service <name>] [--since <duration>]
                                               # tail logs from the active Backend's log store
                                               #   (per-backend storage detail in the backend docs)
afk kill <run-id>                              # terminate the Run's compute primitive
afk session-artifact [--out <dir>] <run-id>    # download the Run's Session Artifact(s) (see contract below)
                                               #   writes to ./session-artifacts/ by default;
                                               #   collected best-effort from the main service at Run end;
                                               #   Owner-scoped like `afk logs`

afk secrets put <name> [value]                 # write to the active Backend's secret store
                                               #   - value omitted: prompts on stdin (hidden) OR reads stdin if piped
                                               #   - inline value: visible in `ps`; prefer stdin for real secrets
                                               #   e.g. `gcloud secrets versions access latest --secret=GH | afk secrets put github-token`
afk secrets ls                                 # list stored secret names
afk secrets rm <name>                          # delete from the active Backend's secret store

afk team add <name> [--principal <arn>]        # admin: provision a developer on the active Backend
  --principal <arn>                            #   AWS only: trust an existing ARN instead of creating an IAM user
afk team ls                                    # admin: list members
afk team rm <name>                             # admin: revoke access

# Global flags
--json                                         # machine-readable JSON output
--verbose / -v                                 # debug logging
--quiet / -q                                   # errors only
--local                                        # run this command on the Local Backend (your own Docker
                                               #   daemon), overriding the persisted backend for this invocation
```

**Command semantics worth knowing:**

- `afk run "<command>"` and `afk run <command> <args…>` both work. The container's CMD becomes `sh -c "<joined command>"`, so quoting and shell features (`&&`, `|`, `$VARS`) work as you'd expect.
- The region a cloud command operates on comes from `afk.config.json` → `aws.region` / `gcp.region` (zone/machine type live in the `gcp` block). There is no per-command `--region` flag (apart from `afk init`, which writes the region into the rendered backend.tf and scaffolded config).
- `aws`, `gcp`, `cloudflare`, and `local` Backends are supported; Azure VMs are still anticipated. `--local` overrides the persisted backend for one invocation and may appear anywhere on the line.

All AWS calls go through the standard credential chain (`AWS_PROFILE`, env vars, IMDS). Developers act under an IAM role provisioned by the Terraform. All Cloudflare calls go through the launcher Worker, authenticated by a per-developer Cloudflare Access service token (provisioned by `afk team add`) — the CLI never talks to the CF control-plane API directly except during `afk init` / `afk golden build`. The `team` commands require admin permissions on either Backend (a separate IAM policy on AWS; a Worker secret-gated `/team` route on Cloudflare).

---

## The consumer contract

A repo that wants to use AFK must provide:

### 1. An `afk.Dockerfile` at the repo root

The file **must** be named `afk.Dockerfile` so it is namespaced away from any other Dockerfile the project uses for its own deployment.

- Installs the toolchain and dependencies needed by the Run's command.
- **Does not `COPY` source code.** Source is cloned at Run start (see [Source code handling](#source-code-handling)).
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

When the Run needs sidecar services, declare them in a compose file. One service — the "main service," named in `afk.config.json` (default: `agent`) — is the agent; its image must be `${AFK_IMAGE}` (the CLI substitutes the agent image's registry URI at submit time). Other services are stock images.

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

The CLI exports three shell variables before invoking `docker compose up` on the Run's compute primitive, which compose substitutes into the above file:

- `AFK_IMAGE` — the registry URI (or local tag) of the wrapped agent image the CLI just built.
- `AFK_COMMAND` — the command from `afk run <args…>` as a shell-quoted string. If the dev's main service hardcodes `command:`, that wins instead.
- `AFK_ENV_FILE` — path to a file containing every value from `.afk.env` plus AFK-injected variables (`AFK_GIT_URL`, `AFK_GIT_REF`, `AFK_RUN_ID`, `AFK_TIMEOUT_SECONDS`, decrypted SSM secrets). The main service must reference it via `env_file:` to receive them.

Restrictions enforced by the CLI at submit time:

- No `restart: always` or `restart: unless-stopped` on the main service (would fight Run-ends-on-exit semantics).
- `ports:` on any service generates a warning — inbound is unreachable at the network level on every Backend.
- The main service must reference `${AFK_IMAGE}`.
- Missing `env_file:` on the main service produces a warning (the entrypoint will fail without `AFK_GIT_URL` / `GITHUB_TOKEN`).

Sidecars share the Run's Docker daemon and network. `/workspace` is mounted into the main service only; declare a named volume in the compose file if other services need source access.

### 3. `afk.config.json`

```json
{
  "backend": "aws",
  "gitUrl": "https://github.com/you/your-repo.git",
  "mainService": "agent",
  "sessionArtifacts": ["/root/.claude/projects/**/*.jsonl"],
  "defaultInstanceType": "t3.medium",
  "allowedInstanceTypes": [
    "t3.medium", "t3.large", "t3.xlarge",
    "m6a.large", "m6a.xlarge", "m6a.2xlarge", "m6a.4xlarge"
  ],
  "defaultTimeoutHours": 4,
  "golden": {
    "cachedImages": ["postgres:16", "redis:7", "node:20"]
  },
  "aws": {
    "region": "eu-west-1"
  },
  "cloudflare": {
    "accountId": "abc123…",
    "workerName": "afk-launcher",
    "workerUrl": "https://afk-launcher.<acct>.workers.dev",
    "placement": "smart",
    "defaultInstanceTier": "standard-1",
    "cachedImages": ["postgres:16", "redis:7"]
  }
}
```

`backend` and `gitUrl` are required (`backend` is one of `aws`, `cloudflare`, `local`). `mainService` defaults to `agent`. `sessionArtifacts` is optional: a list of container-side path globs, resolved **inside the main service only**, that afk collects (best-effort, at graceful exit) and stores per Run for later `afk session-artifact <run-id>` retrieval — the motivating case being an AI agent's structured `.jsonl` transcript. Files over the size cap are skipped with a warning rather than truncated; a glob matching nothing warns but never changes the Run's exit status. Collection is a single snapshot at the Run command's graceful exit, so it captures the Run's own execution only — not anything done in a later `afk attach` session, and not a Run that was `afk kill`-ed or hard-timed-out before exiting. Only the block matching the active `backend` is consulted — `aws:`, `cloudflare:`, and `local:` may coexist, and `afk init --provider <other>` re-runs are non-destructive of the other blocks.

- **Local-specific.** The `local:` block needs only `cachedImages` (the sidecar images baked into the local Golden Image). Everything else the Local Backend uses comes from the Backend-neutral top level (`gitUrl`, `mainService`, `defaultTimeoutHours`).

- **AWS-specific.** `aws.region` selects the region for every AWS call the CLI makes; defaults to `us-east-1` if omitted. Resource and Golden-Image settings are optional. Most runtime values the CLI needs (VPC ID, subnet IDs, role ARNs) are derived from tags + IAM lookups against the configured region — not read from this file.
- **Cloudflare-specific.** `cloudflare.accountId` and `cloudflare.workerUrl` are required for any CF command after `afk init`. `placement` (default `smart`) maps to Cloudflare Containers placement hints. `defaultInstanceTier` (default `standard-1`) is the CF Containers tier per Run. `cachedImages` is the list passed to `afk golden build` for inclusion in the Golden Container image.

### 4. `.afk.env` (gitignored)

Contains environment variables for Runs. Values may be plain strings (for non-secrets) or `secret:<name>` references (for values stored in the active Backend's secret store).

```
LOG_LEVEL=debug
ANTHROPIC_API_KEY=secret:anthropic-key
DATABASE_URL=secret:db-url

# GitHub-hosted repos: the entrypoint clones with `x-access-token:<GITHUB_TOKEN>@…`
GITHUB_TOKEN=secret:github-token

# GitLab-hosted repos (gitlab.com or self-hosted): the entrypoint clones with `oauth2:<GITLAB_TOKEN>@…`
# GITLAB_TOKEN=secret:gitlab-token
```

The scm-token variable name is host-dependent — the entrypoint matches the `gitUrl` host: `*.github.com` requires `GITHUB_TOKEN`, `*gitlab*` requires `GITLAB_TOKEN`. Set whichever your origin uses; you don't need both.

Secret _values_ are never written here — only `secret:<name>` references. The values themselves are stored separately via `afk secrets put <name> <value>`; see [Secrets](#secrets) for where each Backend keeps them.

---

## Concepts

See [`CONTEXT.md`](./CONTEXT.md) for the canonical glossary. Quick orientation:

- **Run** — one ephemeral execution of a developer-defined command, backed by exactly one compute primitive (an EC2 instance on AWS, a Container instance on Cloudflare). The primitive boots, runs the workload, and self-terminates on exit.
- **Backend** — provider implementation. **AWS EC2**, **GCP Compute Engine**, **Cloudflare Containers**, and **Local** (your own Docker daemon) are shipped; Azure (Virtual Machines) is anticipated.
- **Owner** — the developer principal that launched a Run (AWS IAM userid, or Cloudflare Access service-token client-id). Used for access control.
- **Dockerfile Contract** — the rules a consumer's `afk.Dockerfile` must follow.
- **Compose Contract** — the (optional) rules a consumer's `afk.compose.yml` must follow when the Run needs sidecar services.
- **Golden Image** — the per-Backend boot artifact used by every Run. An AMI on AWS, a Container image on Cloudflare. Pure Docker engine + sidecar cache, nothing more.
- **Ref** — the git reference a Run executes against.

---

## Backends

The same CLI surface runs on four shipped backends — pick one with `afk init --provider <name>`, or use `--local` per command. Each backend's deep detail (what it provisions, attach / lifecycle / cost specifics, teardown) lives in its own doc:

- **[AWS EC2](./docs/backends/aws.md)** — one EC2 VM per Run, Terraform-provisioned (VPC, IAM, sweeper Lambda, DynamoDB, S3 state). Full Compose Contract. Spot by default (`--on-demand` for pricier, non-preemptible capacity).
- **[GCP Compute Engine](./docs/backends/gcp.md)** — one Compute Engine VM per Run, Terraform-provisioned (VPC + NAT + IAP, service accounts, Firestore, Artifact Registry, reconcile Cloud Function, GCS state). Full Compose Contract. Spot by default (`--on-demand` to opt out); attach over an IAP tunnel.
- **[Cloudflare Containers](./docs/backends/cloudflare.md)** — one Container instance per Run via a customer-deployed launcher Worker (rootless dind). Requires the Workers Paid plan.
- **[Local](./docs/backends/local.md)** — one container per Run on your own Docker daemon (rootless dind), fully self-contained. Needs only Docker; selectable persistently or via `--local`.

Azure (Virtual Machines) is anticipated — see [Future Backends](#future-backends).

---

## Secrets

- Secret values are stored in the active Backend's secret store, written by `afk secrets put`.
- Secret _references_ live in `.afk.env` as `secret:<name>`. The reference syntax is canonical across Backends.
- `.afk.env` is gitignored by default. The CLI refuses to start if `.afk.env` is tracked by git.

The Run needs at minimum a `github-token` secret to clone source.

Where values are stored is backend-specific — **SSM Parameter Store** on AWS, **Workers Secrets** on Cloudflare, a `~/.afk/secrets/` file on **Local**. See the [backend docs](#backends) for per-backend storage and resolution detail.

---

## Attach, lifecycle, state & costs

These are backend-specific — `afk attach` (SSM on AWS, IAP tunnel + OS Login on GCP, `wrangler containers ssh` on Cloudflare, nested `docker exec` on Local), how a Run self-terminates and what backstops a wedged one, how `afk ls`/`afk history` read live vs. archived state, and per-Run cost — and are documented per backend:

- AWS: [docs/backends/aws.md](./docs/backends/aws.md) (attach, lifecycle, querying, costs)
- GCP: [docs/backends/gcp.md](./docs/backends/gcp.md) (attach, lifecycle, querying, costs)
- Cloudflare: [docs/backends/cloudflare.md](./docs/backends/cloudflare.md)
- Local: [docs/backends/local.md](./docs/backends/local.md)

Backend-neutral commands stay identical across all four (see [CLI surface](#cli-surface)).

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
├── terraform/              # AWS Backend infra — copyable modules (afk init drops one into the dev's repo)
│   └── aws/                # AWS Backend — EC2 VM per Run
│       ├── main.tf
│       ├── vpc.tf
│       ├── iam.tf
│       ├── sweeper.tf
│       ├── lambda/
│       │   └── sweeper/    # sweeper Lambda source (TypeScript, bundled at apply time)
│       ├── variables.tf
│       └── outputs.tf
│   # future: gcp/, azure/
├── worker/                 # Cloudflare Backend infra — copyable launcher Worker
│   └── cloudflare/         # Cloudflare Backend — Container instance per Run
│       ├── src/            # Hono router + per-Run Durable Object + registry DO
│       ├── migrations/     # D1 schema (runs history table)
│       ├── wrangler.toml.template  # rendered by afk init
│       └── README.md       # CF-specific topology + deploy notes
├── entrypoint/             # CLI-injected container entrypoint (shared across Backends)
│   └── entrypoint.sh
└── examples/               # example consumer repos
```

---

## Future Backends

The CLI is structured around a `Backend` interface. **AWS EC2**, **GCP Compute Engine**, **Cloudflare Containers**, and **Local** (your own Docker daemon) are shipped. **Azure (Virtual Machines)** is anticipated; it is expected to follow the same one-compute-primitive-per-Run shape, with its own image-build pipeline mapped onto `afk golden build` and its own exec primitive mapped onto `afk attach`.
