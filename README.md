# AFK

Run ephemeral containerized tasks in the cloud from a CLI. Built for AI agents that work while you're AFK ("away from keyboard"), but works for any cli-runnable workload.

Each Run executes on a short-lived **compute primitive** that the developer owns end-to-end — an EC2 VM on the AWS Backend, a Cloudflare Container instance on the Cloudflare Backend. Either way the Run has Docker available (the host daemon on AWS, rootless `dind` on Cloudflare), so `docker compose up` is the same surface across providers — giving the agent first-class access to sidecar services (Postgres, Redis, etc.) without the limitations of serverless container platforms.

This repository is the **base layer**: it ships the per-Backend infra (Terraform for AWS, a launcher Worker for Cloudflare), the CLI that drives them, and the contract that consumers must follow in their own repos.

---

## Concepts

See [`CONTEXT.md`](./CONTEXT.md) for the canonical glossary. Quick orientation:

- **Run** — one ephemeral execution of a developer-defined command, backed by exactly one compute primitive (an EC2 instance on AWS, a Container instance on Cloudflare). The primitive boots, runs the workload, and self-terminates on exit.
- **Backend** — cloud-provider implementation. **AWS EC2** and **Cloudflare Containers** are shipped; GCP (Compute Engine) and Azure (Virtual Machines) are anticipated.
- **Owner** — the developer principal that launched a Run (AWS IAM userid, or Cloudflare Access service-token client-id). Used for access control.
- **Dockerfile Contract** — the rules a consumer's `afk.Dockerfile` must follow.
- **Compose Contract** — the (optional) rules a consumer's `afk.compose.yml` must follow when the Run needs sidecar services.
- **Golden Image** — the per-Backend boot artifact used by every Run. An AMI on AWS, a Container image on Cloudflare. Pure Docker engine + sidecar cache, nothing more.
- **Ref** — the git reference a Run executes against.

---

## How it works (end-to-end)

The walkthrough below describes the AWS Backend. The Cloudflare Backend follows the same conceptual shape — the same `afk` CLI surface, the same `afk.Dockerfile` + `afk.compose.yml` contract, the same Owner / Ref / Golden Image concepts — but swaps EC2 + Terraform for Cloudflare Containers + a launcher Worker. See [Quickstart on Cloudflare](#quickstart-on-cloudflare) and [`worker/cloudflare/README.md`](./worker/cloudflare/README.md) for the CF-specific topology.

1. Developer runs `afk init --provider aws --region <region>` in their repo once. CLI creates the Terraform state S3 bucket (`afk-tf-state-<account>-<region>`), copies the matching Backend Terraform module into their repo (`terraform/aws/` → consumer's `terraform/afk/`), renders `backend.tf` with the bucket/region, scaffolds `.afk.env` and `afk.config.json` (with `backend: "aws"` and `aws.region`), and gitignores `.afk.env`. `--provider` defaults to `aws`; `--region` defaults to `us-east-1`.
2. Developer runs `terraform apply` from `terraform/afk/`. This creates the VPC, security groups, IAM roles and policies, the sweeper Lambda, and the developer IAM role.
3. Developer builds the Golden Image: `afk golden build`. The CLI launches a short-lived builder EC2 instance, installs Docker, pre-pulls the images listed in `afk.config.json` under `golden.cachedImages`, snapshots the result as an AMI tagged `afk:golden=true`, and terminates the builder.
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
   - Resolves `secret:<name>` env vars by reading SSM Parameter Store.
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

## Distribution & install

This repo is **not published to a registry**. Developers consume it by cloning.

```sh
git clone <this-repo> ~/afk
cd ~/afk/cli
bun install
bun link              # registers @afk/cli globally
```

`bun link` puts a symlink at `~/.bun/bin/afk` that resolves back to this checkout. If `~/.bun/bin` is on your PATH (Bun's installer adds it by default), `afk` is now usable from any project. Editing the source in your checkout takes effect immediately — no relink needed.

Prerequisites on the developer machine:

- Bun (runtime)
- Docker (image builds)
- A working `git` credential helper that can read your private remote (`gh auth setup-git` is the easiest if you have the GitHub CLI installed)

For the **AWS Backend** additionally:

- Terraform ≥ 1.10 (for S3 native state locking)
- AWS CLI (credential chain) with creds for the target account
- `session-manager-plugin` (required for `afk attach`)
- `npm` (the sweeper Lambda is bundled with esbuild at `terraform apply` time)

For the **Cloudflare Backend** additionally:

- `wrangler` (Cloudflare's deploy CLI) on PATH
- `CLOUDFLARE_API_TOKEN` exported, scoped for `Workers Scripts:Edit`, `Containers:Edit`, `D1:Edit`, `Workers KV:Edit`, `Access:Edit`
- A Cloudflare account on the Workers Paid plan (Containers requires it)

Updates: `git pull && bun install`. There is no version pinning; consumers run whatever sha they checked out.

---

## Quickstart

Pick the Backend you want to run on. The CLI surface (`afk run`, `afk ls`, `afk attach`, …) is identical from there.

### Quickstart on AWS

In a fresh consumer repo:

```sh
# 1. Bootstrap (creates the state bucket + scaffolds files)
afk init --provider aws --region eu-west-1

# 2. Provision infra (VPC, IAM, sweeper Lambda)
cd terraform/afk
terraform init
terraform apply -var aws_region=eu-west-1
cd -

# 3. Build the Golden Image (one-time per account/region; ~5 min)
afk golden build

# 4. Store secrets (at minimum a GitHub PAT so the VM can clone source)
afk secrets put github-token <PAT>
echo "GITHUB_TOKEN=secret:github-token" >> .afk.env

# 5. Author your contract files (commit + push)
#    - afk.Dockerfile          (toolchain only; no COPY of source; no ENTRYPOINT)
#    - afk.compose.yml         (optional; main service must reference ${AFK_IMAGE})
git add afk.Dockerfile afk.compose.yml afk.config.json .afk.env  # .afk.env should already be gitignored
git commit -m "configure AFK"
git push

# 6. Launch a Run
afk run bun --version
afk ls
afk logs <run-id>
```

Teardown when you're done:

```sh
afk golden rm <ami-id>          # delete the Golden AMI
cd terraform/afk && terraform destroy -var aws_region=eu-west-1
aws ssm delete-parameter --name /afk/secrets/github-token --region eu-west-1
aws ecr delete-repository --repository-name afk/<your-repo> --force --region eu-west-1
aws s3 rb s3://afk-tf-state-<account-id>-eu-west-1 --force
```

### Quickstart on Cloudflare

> **Read first:** the CF Backend uses **rootless Docker-in-Docker** inside one Container instance per Run, gated by a customer-deployed **launcher Worker**. Different topology from AWS; same `afk` CLI surface. Skim [Cloudflare Backend — concepts and limitations](#cloudflare-backend--concepts-and-limitations) below before starting if this is your first CF Backend deploy.

In a fresh consumer repo:

```sh
# 0. Prerequisites.
#    - Cloudflare account on the Workers Paid plan ($5/mo; Containers requires it).
#    - `wrangler` on PATH (`npm i -g wrangler` or `bun i -g wrangler`).
#    - A Cloudflare API token in your env. Required scopes:
#        Account: Workers Scripts:Edit, Workers KV Storage:Edit,
#                 D1:Edit, Containers:Edit, Access: Edit.
export CLOUDFLARE_API_TOKEN=<your-token>

# 1. Bootstrap: copies the launcher Worker into worker/afk/ + scaffolds afk.config.json
#    with a `cloudflare:` block. Does NOT call any Cloudflare API yet.
afk init --provider cloudflare

# 2. One-time: provision the launcher Worker's backing resources.
cd worker/afk
npm install
wrangler d1 create afk-launcher-history
#   → paste the returned database_id into wrangler.toml under [[d1_databases]]
wrangler kv:namespace create DEVELOPERS_KV
#   → paste the returned namespace id into wrangler.toml under [[kv_namespaces]]
wrangler d1 execute afk-launcher-history --file=migrations/0001_runs.sql --remote

# 3. Fill in the obvious placeholders in BOTH files:
#    - wrangler.toml      → account_id (account ID, not the API token)
#    - afk.config.json    → cloudflare.accountId, cloudflare.workerName
#    (You'll come back to fill in `cloudflare.workerUrl` and the wrangler.toml
#    `image = ...` field after step 5 — they don't exist yet.)

# 4. Build the Golden Container image. Produces the image the Worker's Container
#    binding boots from. Pushes to registry.cloudflare.com/<accountId>/afk-golden:<v>.
afk golden build
#   → copy the printed image URI into wrangler.toml's [[containers]] image field.

# 5. Deploy the launcher Worker and set its admin-scoped API token (used by the
#    Worker to provision Access service tokens for developers via /team).
wrangler deploy
wrangler secret put CF_API_TOKEN
#   → wrangler prints the deployed Worker URL (https://<name>.<subdomain>.workers.dev).
#   → paste it into afk.config.json's cloudflare.workerUrl.
cd -

# 6. Auth mode. As of v2, the CLI sends Cloudflare Access service-token
#    headers (`Cf-Access-Client-Id` + `Cf-Access-Client-Secret`). You must:
#       (a) Wrap the Worker URL in a Cloudflare Access application via the
#           Zero Trust dashboard.
#       (b) Configure that Access app to allow service tokens.
#       (c) Add the tokens provisioned in step 7 to its allow policy.
#    The Worker's single-dev `AFK_SHARED_TOKEN` fallback is accepted server-
#    side but the CLI does not send a bearer token; that path needs a
#    follow-up commit to be reachable. Until then, use Access service tokens.

# 7. Provision yourself as a developer. On (a) this creates a CF Access service
#    token via the Worker and prints { clientId, clientSecret } ONCE.
#    On (b) you can skip this — the shared bearer is your auth.
afk team add <your-name>
#   → export the printed values for every subsequent CLI call:
export AFK_CF_CLIENT_ID=<printed clientId>
export AFK_CF_CLIENT_SECRET=<printed clientSecret>

# 8. Verify the install.
afk doctor    # checks wrangler, CLOUDFLARE_API_TOKEN, worker reachability,
              # golden image presence.

# 9. Store secrets (at minimum a GitHub PAT so the Container can clone source).
#    Stored as Workers Secrets on the launcher Worker; referenced via secret:<name>.
afk secrets put github-token <PAT>
echo "GITHUB_TOKEN=secret:github-token" >> .afk.env

# 10. Author your contract files (commit + push) — same as AWS.
git add afk.Dockerfile afk.compose.yml afk.config.json .afk.env  # .afk.env should already be gitignored
git commit -m "configure AFK"
git push

# 11. Launch a Run.
afk run bun --version
afk ls
afk logs <run-id>
```

Teardown when you're done:

```sh
afk golden rm <image-tag>            # delete the Golden Container image
cd worker/afk && wrangler delete     # remove the launcher Worker + DOs
wrangler d1 delete afk-launcher-history
wrangler kv:namespace delete --binding DEVELOPERS_KV
# Optionally delete the Access service tokens via the Zero Trust dashboard.
```

See [`worker/cloudflare/README.md`](./worker/cloudflare/README.md) for the launcher Worker's internals.

#### Cloudflare Backend — concepts and limitations

**Topology you're paying for.** Each Run on CF gets its own Cloudflare Container instance (~equivalent to a tiny VM you don't see), bound to a Durable Object inside the launcher Worker you just deployed. The Container boots from the Golden Container image (rootless dind + your pre-pulled sidecars), the dind spins up, and `docker compose up` runs the dev's `afk.compose.yml` inside it. When the agent exits, the Container stops; the Worker's DO records the row in D1 and unregisters from the in-memory index.

**Two auth boundaries.** The CLI authenticates to the launcher Worker on every call; the Worker authenticates to Cloudflare APIs on the CLI's behalf for admin operations.

- **CLI → Worker** uses `Cf-Access-Client-Id` + `Cf-Access-Client-Secret` headers (CF Access service tokens). The Worker also accepts `Authorization: Bearer <AFK_SHARED_TOKEN>` for single-dev mode, but the CLI does not currently emit a Bearer header — that path is server-side-only as of v2 and is tracked in IMPROVEMENTS.md. Production deploys must use Access service tokens.
- **Worker → CF API** uses the `CF_API_TOKEN` Worker secret you set in step 5. This is the admin-scoped token; it never leaves the Worker.

**What `afk team add` does.** On the CF Backend it calls the Worker's `/team` route, which uses `CF_API_TOKEN` to create a real CF Access service token and stores the `client_id → display_name` mapping in the DEVELOPERS_KV namespace. The `client_secret` is shown **once**; export it as `AFK_CF_CLIENT_SECRET` and `AFK_CF_CLIENT_ID` for every subsequent CLI call. Losing the secret means re-running `afk team add` under a new name.

**Cloudflare Access application setup (mode (a)).** For Access service tokens to actually gate the Worker, you have to wrap the deployed Worker URL in a Cloudflare Access application via the Zero Trust dashboard. Configure it to allow service tokens and add the ones you created with `afk team add` to its policy. Without this, the Worker is publicly reachable and `authenticate()` falls back to the shared-bearer path (or rejects every request if `AFK_SHARED_TOKEN` isn't set). Mode (b) — `AFK_SHARED_TOKEN` only — skips Access entirely; the Worker URL is still reachable by anyone who knows the URL but rejects requests without the bearer.

**Compose rules the CLI auto-injects on CF.** Every service in your `afk.compose.yml` gets `network_mode: host` plus `extra_hosts:` entries cross-mapping every sibling service name to `127.0.0.1`. You don't write these — the CLI mutates the in-memory compose before sending it to the Worker. Inter-service DNS keeps working (`postgres:5432` resolves to `127.0.0.1:5432`) but two sidecars cannot bind the same port. Port collisions are a hard error at submit time.

**Logs.** Workers Logs only — **3 days retention on Workers Free, 7 days on Workers Paid**. There is no AFK-managed R2 mirror; if you need >7d retention, configure Logpush on your account separately. `afk logs <run-id> --follow` shells out to `wrangler tail` filtered by `runId`.

**Known TODOs (track in `IMPROVEMENTS.md`).**

| Area | Status | Impact on first-time use |
|---|---|---|
| CF Container registry listing (`afk golden ls` / the post-build "find latest" check) | ⏳ stubbed — returns `[]` / `null` | `afk run` on CF refuses to launch with `"Run \`afk golden build\` first"` even after a successful build, because the launcher-side presence check can't see the tag yet. **Workaround until shipped:** the CLI's `CloudflareCompute.prepare` check is a soft block; comment it out locally for the first end-to-end smoke test, or wait for the registry listing PR. |
| GraphQL Analytics for historical Workers Logs | ⏳ shelled out to `wrangler tail` | Historical reads (`afk logs <id>` without `--follow`) miss events older than the tail window. |
| WSS attach end-to-end | ⏳ code written, not exercised live | `afk attach` likely needs SIGWINCH / header tweaks once tested against a real Container. |
| Single-dev shared-bearer (`AFK_SHARED_TOKEN`) | ⏳ Worker accepts, CLI never sends | Use Access service tokens; the bearer-only path is half-wired. |
| Real-account integration test | ⏳ none of PR 2–5 deployed | Expect 1–2 round trips of small fixes during your first deploy. |

The AWS Backend has none of the four caveats above.

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

`backend` and `gitUrl` are required. `mainService` defaults to `agent`. Only the block matching the active `backend` is consulted — both `aws:` and `cloudflare:` may coexist, and `afk init --provider <other>` re-runs are non-destructive of the other block.

- **AWS-specific.** `aws.region` selects the region for every AWS call the CLI makes; defaults to `us-east-1` if omitted. Resource and Golden-Image settings are optional. Most runtime values the CLI needs (VPC ID, subnet IDs, role ARNs) are derived from tags + IAM lookups against the configured region — not read from this file.
- **Cloudflare-specific.** `cloudflare.accountId` and `cloudflare.workerUrl` are required for any CF command after `afk init`. `placement` (default `smart`) maps to Cloudflare Containers placement hints. `defaultInstanceTier` (default `standard-1`) is the CF Containers tier per Run. `cachedImages` is the list passed to `afk golden build` for inclusion in the Golden Container image.

### 4. `.afk.env` (gitignored)

Contains environment variables for Runs. Values may be plain strings (for non-secrets) or `secret:<name>` references (for values stored in the active Backend's secret store).

```
LOG_LEVEL=debug
ANTHROPIC_API_KEY=secret:anthropic-key
DATABASE_URL=secret:db-url
```

Secrets themselves are stored separately via `afk secrets put <name> <value>`. The backing store is Backend-specific (SSM Parameter Store SecureString on AWS; Workers Secrets on Cloudflare, written via the launcher Worker's `/secrets` route), but the `secret:<name>` reference syntax is canonical and identical across Backends.

---

## CLI surface

```
afk init [--provider <aws|cloudflare>] [--region <region>]
                                               # one-time setup in a repo (scaffolds config + Backend infra)
                                               # --provider defaults to aws; --region applies to provider=aws only
afk doctor                                     # check dependencies, Backend creds, Golden Image presence + age
afk config                                     # print resolved config (debug)

afk golden build                               # build the Golden Image for the active Backend
                                               #   AWS: an AMI tagged afk:golden=true
                                               #   CF:  a Container image in the CF managed registry
afk golden ls                                  # list Golden Images for the active Backend
afk golden rm <id-or-tag>                      # delete a Golden Image

afk build [--ref <ref>]                        # explicit container image build + push (afk run also builds if needed)
afk run <command…>                             # launch a Run
  --ref <branch|sha|tag>                       #   defaults to current local branch
  --instance-type <type>                       #   AWS only: overrides project default EC2 type
  --on-demand                                  #   AWS only: disable Spot for this Run (default is Spot)
  --instance-tier <tier>                       #   CF only: overrides project default CF Containers tier
  --timeout <hours>                            #   overrides default (4h)
  --detach / -d                                #   default: launch and exit (currently the only mode)
afk ls [--all] [--status <s>]                  # list Runs (yours by default; --all = team-wide if permitted)
afk attach <run-id> [--service <name>] [--host]
                                               # interactive shell. Default: docker exec into main service.
                                               # --service <name>: attach to a sidecar instead.
                                               # --host:           drop to the VM's host shell.
afk logs <run-id> [--follow] [--service <name>] [--since <duration>]
                                               # tail logs from the active Backend's log store
                                               #   AWS: CloudWatch Logs (`aws logs tail` under the hood)
                                               #   CF:  Workers Logs (via `wrangler tail` for now)
afk kill <run-id>                              # ec2:TerminateInstances on the Run

afk secrets put <name> [value]                 # write to the active Backend's secret store (prompts if value omitted)
afk secrets ls                                 # list stored secret names
afk secrets rm <name>                          # delete from the active Backend's secret store

afk team add <name> [--principal <arn>]        # admin: provision a developer (IAM user or trusted principal)
afk team ls                                    # admin: list members
afk team rm <name>                             # admin: revoke access

# Global flags
--json                                         # machine-readable JSON output
--verbose / -v                                 # debug logging
--quiet / -q                                   # errors only
```

**Command semantics worth knowing:**

- `afk run "<command>"` and `afk run <command> <args…>` both work. The container's CMD becomes `sh -c "<joined command>"`, so quoting and shell features (`&&`, `|`, `$VARS`) work as you'd expect.
- The region every AWS command operates on comes from `afk.config.json` → `aws.region`. There is no per-command `--region` flag (apart from `afk init`, which writes the region into the rendered backend.tf and scaffolded config).
- Both `aws` and `cloudflare` Backends are supported as of v2; `--local`, GCE, and Azure VMs are still anticipated.

All AWS calls go through the standard credential chain (`AWS_PROFILE`, env vars, IMDS). Developers act under an IAM role provisioned by the Terraform. All Cloudflare calls go through the launcher Worker, authenticated by a per-developer Cloudflare Access service token (provisioned by `afk team add`) — the CLI never talks to the CF control-plane API directly except during `afk init` / `afk golden build`. The `team` commands require admin permissions on either Backend (a separate IAM policy on AWS; a Worker secret-gated `/team` route on Cloudflare).

---

## What the backend provisions

Each Backend has its own one-time infra setup. The CLI surface is identical from there.

### AWS Terraform

A consumer of this repo runs the Terraform once per AWS account/team. It creates:

#### Networking

- A dedicated VPC across 2 AZs.
- Public subnets only (no NAT).
- An Internet Gateway.
- A Security Group for Runs: **all inbound denied**, all outbound allowed.
- Run VMs launch with a public IP. Inbound is unreachable; outbound goes direct.

#### Compute

- No long-running compute. The CLI launches one EC2 instance per Run on demand against the Golden AMI.
- A **sweeper Lambda** (TypeScript, bundled at `terraform apply` time) on a 15-minute EventBridge schedule. It terminates AFK-managed instances older than their declared timeout. Backstop against crashed agents.

#### Identity

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

#### Storage / state

- The Terraform state itself lives in an S3 bucket created by `afk init` (not by Terraform — chicken-and-egg). S3 native state locking (`use_lockfile = true`) replaces the older DynamoDB pattern.
- A DynamoDB `afk-runs` table holds Run history (used by `afk history`).

#### Not created by Terraform

- **The Golden AMI** is built by `afk golden build`, not by Terraform. The Terraform grants the permission scope only.
- **ECR repositories** are created lazily by the CLI on first `afk build` for a given source repo, with a 7-day untagged-image lifecycle policy applied at creation.
- **CloudWatch log groups** (`/afk/<source-repo>`) are created lazily by the CLI with 30-day retention.

### Cloudflare Wrangler

A consumer of this repo runs `wrangler deploy` from `worker/afk/` once per Cloudflare account/team after `afk init --provider cloudflare`. The deploy creates:

#### The launcher Worker

- An HTTP/WSS Worker that fronts every AFK operation: `/runs`, `/runs/:id`, `/runs/:id/attach` (WSS), `/secrets`, `/team`, `/health`. The CLI's `CloudflareCompute` layer talks to this Worker — there is no direct CLI→CF-control-plane traffic for normal commands.
- Authenticates each request via the caller's CF Access service-token client-id (`Cf-Access-Client-Id`), or a shared bearer fallback for single-dev mode.

#### Durable Objects

- **`RunDO`** — one per Run. Owns the Run's Container instance, captures stdout/stderr for Workers Logs, and sets an alarm at `startedAt + timeoutHours + 30 min` as a backstop against a stuck Run.
- **`RegistryDO`** — singleton index DO. Backs `afk ls` without fanning out to every per-Run DO.
- Migrations for both DOs are declared in `wrangler.toml` and applied automatically on `wrangler deploy`.

#### The Container binding

- `RunContainer` — the Container class the launcher Worker dispatches Runs to. Each per-Run `RunDO` owns one instance, booted from the Golden Container image referenced in `afk.config.json`.

#### D1 + KV

- **D1 database** (`afk-launcher-history`) — the historical rows table queried by `afk history`. Schema lives in `worker/cloudflare/migrations/0001_runs.sql`, applied via `wrangler d1 execute … --file=… --remote` at init time.
- **KV namespace** (`DEVELOPERS_KV`) — maps Cloudflare Access service-token client-ids to developer display names. Written by `afk team add`.

#### Not created by `wrangler deploy`

- **The Golden Container image** is built by `afk golden build` and pushed to the Cloudflare managed registry. Wrangler does not produce it.
- **Workers Secrets** (`CF_API_TOKEN` and per-Run secrets) are written interactively by `wrangler secret put` (for the admin token) and by the launcher Worker's `/secrets` route (for per-Run secrets the CLI writes via `afk secrets put`).

See [`worker/cloudflare/README.md`](./worker/cloudflare/README.md) for the launcher Worker's source layout and topology diagram.

---

## Local Backend (planned, not yet implemented)

The intent is to let every command accept `--local` to execute against the developer's local Docker daemon instead of the cloud, as a faithful rehearsal of the cloud path (same image build, same entrypoint, same compose file, same secret resolution). This is not yet implemented — `--local` flags will be added once both cloud Backends are hardened. Until then, every command targets the Backend named in `afk.config.json`.

---

## Source code handling

A Run's image contains the toolchain and dependencies — **not** the source. The entrypoint clones the repo at the configured ref into `/workspace` (inside the main service's container) before executing the dev's command.

On Cloudflare: identical contract. The clone runs inside the rootless `dind` inside the Container; `/workspace` is a tmpfs mount inside the main service's container, sized off the CF Containers tier.

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

- Secret values are stored in the active Backend's secret store, written by `afk secrets put`.
- Secret *references* live in `.afk.env` as `secret:<name>`. The reference syntax is canonical across Backends.
- `.afk.env` is gitignored by default. The CLI refuses to start if `.afk.env` is tracked by git.

The Run needs at minimum a `github-token` secret to clone source.

On AWS: values are stored in **SSM Parameter Store SecureString** under `/afk/secrets/<name>`. The CLI passes references to the VM via the `user_data` script, which resolves them at boot using the VM's instance-profile permissions and exports them into the compose stack. Values never appear in `DescribeInstances` output, CloudTrail (beyond the parameter name), or instance tags.

On Cloudflare: values are stored as **Workers Secrets** on the launcher Worker, written via the Worker's `/secrets` route (which the CLI calls on `afk secrets put`). At Run start, the launcher Worker materialises them into the Container's environment. Values never appear in the D1 history table, KV, or Workers Logs.

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

On Cloudflare: SSM has no equivalent. The launcher Worker exposes a WSS endpoint at `/runs/:id/attach`; the CLI opens a WebSocket against it, the Worker proxies the frames into a `docker compose exec -it <service>` inside the Run's outer Container (which is running rootless `dind`). `--service <name>` and `--host` work the same way as on AWS, modulo host-shell meaning "shell into the outer Container, not into a sidecar." Access is gated by the caller's CF Access service token matching the Run's Owner.

---

## Run lifecycle

- A Run's lifetime equals its main service container's lifetime. When the dev's command exits, compose ends with the main service's exit code, the `user_data` script captures that code, and the VM runs `shutdown -h now`.
- The instance is launched with `InstanceInitiatedShutdownBehavior=terminate`, so OS shutdown causes AWS to terminate the instance. No `ec2:TerminateInstances` permission is granted to the VM itself.
- A wall-clock timeout (default 4h, configurable per-Run and project-wide) wraps the compose invocation with `timeout(1)` — SIGTERM after the cap.
- A sweeper Lambda terminates instances whose agent crashed before reaching `shutdown` (any AFK-managed instance older than its declared timeout, with a grace window).
- The CLI does **not** stay resident after `afk run` returns. The Run lives entirely on EC2. The developer's laptop dying mid-Run has no effect on the Run.

On Cloudflare: the Run lives entirely inside a Cloudflare Container instance owned by a per-Run Durable Object. `shutdown -h now` doesn't apply — when the main process inside the Container exits, CF terminates the Container automatically (the DO observes the exit, writes the final row to D1, and cleans up). The timeout backstop is the DO's alarm (set to `startedAt + timeoutHours + 30 min`), not a sweeper Lambda. The agent's `timeout(1)` inside the container is still the primary mechanism.

---

## Run state and querying

`afk ls` reads live Run state from the active Backend's compute-truth source; `afk history` reads persisted historical rows.

On AWS:

- `afk ls` calls `ec2:DescribeInstances` filtered by tags (`afk:owner`, optionally `afk:branch`) and instance-state (`pending`, `running`, `shutting-down`, `stopping`).
- `afk ls --all` drops the owner filter (requires broader IAM).
- EC2 retains terminated instances in `DescribeInstances` for ~1 hour, so very-recently-completed Runs remain visible.
- `afk history` reads from the DynamoDB `afk-runs` table for older Runs.

On Cloudflare:

- `afk ls` calls the launcher Worker, which reads the singleton `RegistryDO` for currently-alive Runs. Each per-Run `RunDO` holds its own state; the registry is the index.
- `afk history` reads from the D1 `afk-launcher-history` table.
- **Logs retention.** Workers Logs retains 3 days on the Free plan, 7 days on the Paid plan. There is no R2 mirror in v1 — if you need longer history, opt into a Cloudflare Logpush export (not AFK-managed).

---

## Costs (baseline)

On AWS:

- VPC + IGW: $0.
- No NAT, no VPC endpoints: $0 baseline.
- Sweeper Lambda + EventBridge schedule: effectively $0 (a few invocations per hour).
- DynamoDB on-demand: effectively $0 baseline for the run-history table.
- Per-Run: EC2 Spot compute (~70% off On-Demand for the same instance type), EBS for the root volume (gp3, ~$0.08/GB-month, only billed while the instance exists), CloudWatch ingest, ECR storage (cycled at 7 days), data egress.
- Spot interruption risk: an interrupted Run dies. Override with `--on-demand` for workloads that can't tolerate this.

On Cloudflare:

- Workers Paid plan ($5/mo) is a hard prerequisite — Cloudflare Containers, Durable Objects, and Workers Logs (7-day retention) all require it.
- Launcher Worker invocations, Durable Object requests, D1 reads/writes, KV reads: bundled into the Paid plan's included quotas at this scale.
- Per-Run: Cloudflare Containers billed per Container-second at the chosen instance tier. No Spot equivalent.
- No baseline NAT / IGW cost — egress is included in the Workers Paid plan.
- Cold start is sub-5s in practice (claim, not yet verified against a real deployment).

---

## Future Backends

The CLI is structured around a `Backend` interface. **AWS EC2** and **Cloudflare Containers** are both shipped. **GCP (Compute Engine)** and **Azure (Virtual Machines)** are anticipated; each is expected to follow the same one-compute-primitive-per-Run shape, with its own image-build pipeline mapped onto `afk golden build` and its own exec primitive mapped onto `afk attach`.

---

## Out of scope for v2

- Notifications on Run completion (no SNS/email/Slack).
- Artifact retrieval beyond logs (agents push their own results — to git, S3, a PR, etc.).
- Multi-region.
- HA NAT / private subnets on AWS (single public-subnet AZ topology only).
- Single-binary distribution (Bun runtime required).
- Cron / scheduled Runs.
- Warm-pool of pre-booted compute primitives (cold start is ~60-90s on AWS, sub-5s on Cloudflare — acceptable for multi-minute workloads on either).
- GPU and bare-metal instance types (deliberately excluded from the default whitelist).
- The `--local` Backend (still planned).
- GCE / Azure VM Backends (still anticipated).
- An R2 mirror of Workers Logs on the Cloudflare Backend (explicitly excluded — users who need >7d retention should opt into a Cloudflare Logpush export, which is not AFK-managed).

These are reachable extensions, not architectural changes.
