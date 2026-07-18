---
title: Configuration
description: The afk.config.json schema, the .afk.env file, and how secrets are referenced and stored per Backend.
---

## `afk.config.json`

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
  "gcp": {
    "projectId": "my-project",
    "region": "us-central1",
    "zone": "us-central1-a",
    "defaultMachineType": "e2-standard-4",
    "allowedMachineTypes": ["e2-medium", "e2-standard-2", "e2-standard-4"],
    "cachedImages": ["postgres:16", "redis:7"]
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

`backend` and `gitUrl` are required (`backend` is one of `aws`, `gcp`,
`cloudflare`, `local`). `mainService` defaults to `agent`. `sessionArtifacts` is
optional — see [Session Artifacts](#session-artifacts) below.

Only the block matching the active `backend` is consulted — `aws:`, `gcp:`,
`cloudflare:`, and `local:` may coexist, and `afk init --provider <other>` re-runs
are non-destructive of the other blocks.

### Per-Backend blocks

- **Local.** The `local:` block needs only `cachedImages` (the sidecar images
  baked into the local Golden Image). Everything else comes from the
  Backend-neutral top level (`gitUrl`, `mainService`, `defaultTimeoutHours`).
- **AWS.** `aws.region` selects the region for every AWS call; defaults to
  `us-east-1` if omitted. Most runtime values the CLI needs (VPC ID, subnet IDs,
  role ARNs) are derived from tags + IAM lookups against the configured region —
  not read from this file.
- **GCP.** `gcp.projectId`, `region`, and `zone` locate every GCE call
  (scaffolded by `afk init` from your active gcloud config).
  `defaultMachineType` is used when `afk run` is called without
  `--instance-type`; `allowedMachineTypes` is the whitelist it is validated
  against. `cachedImages` is the sidecar pre-pull list baked into the Golden
  Image.
- **Cloudflare.** `cloudflare.accountId` and `cloudflare.workerUrl` are required
  for any CF command after `afk init`. `placement` (default `smart`) maps to
  Cloudflare Containers placement hints. `defaultInstanceTier` (default
  `standard-1`) is the CF Containers tier per Run. `cachedImages` is the list
  passed to `afk golden build`.

## Session Artifacts

`sessionArtifacts` is a list of container-side path globs, resolved **inside the
main service only** (never sidecars), that afk collects when the Run ends and
persists for later review — the motivating case being an AI agent's session
transcript (e.g. Claude Code's `~/.claude/projects/**/*.jsonl`). See the
[glossary entry](/afk/concepts/glossary/#session-artifact) for the concept; the
mechanics are the same on every Backend:

- **One collection point.** The declared base dirs are `docker cp`'d out of the
  main service at the Run command's **graceful exit** — a single snapshot of the
  Run's own execution. A Run that is `afk kill`-ed or hard-timed-out never
  reaches it (collection is best-effort), and nothing done in a later
  `afk attach` session is ever captured.
- **Caps and misses.** Files over the ~25 MB per-file cap are skipped with a
  warning, never truncated. A glob matching nothing warns but never changes the
  Run's exit status.
- **Retrieval.** `afk session-artifact <run-id> [--out <dir>]` fetches the
  stored blob, applies the precise globs + cap, and writes the survivors to
  `--out` (default `./session-artifacts/`). Owner-scoped like `afk logs`.

Where the blob lands between exit and retrieval is Backend-specific — S3 on AWS,
GCS on GCP, R2 (via the launcher Worker) on Cloudflare, `~/.afk/runs/<id>/` on
Local; each backend page documents its transport and expiry.

## `.afk.env` (gitignored)

Contains environment variables for Runs. Values may be plain strings (for
non-secrets) or `secret:<name>` references (for values stored in the active
Backend's secret store).

```
LOG_LEVEL=debug
ANTHROPIC_API_KEY=secret:anthropic-key
DATABASE_URL=secret:db-url

# GitHub-hosted repos: the entrypoint clones with `x-access-token:<GITHUB_TOKEN>@…`
GITHUB_TOKEN=secret:github-token

# GitLab-hosted repos (gitlab.com or self-hosted): the entrypoint clones with `oauth2:<GITLAB_TOKEN>@…`
# GITLAB_TOKEN=secret:gitlab-token
```

The scm-token variable name is host-dependent — the entrypoint matches the
`gitUrl` host: `*.github.com` requires `GITHUB_TOKEN`, `*gitlab*` requires
`GITLAB_TOKEN`. Set whichever your origin uses; you don't need both.

Secret _values_ are never written here — only `secret:<name>` references. The
values themselves are stored separately via `afk secrets put <name> <value>`.

## Secrets

- Secret values are stored in the active Backend's secret store, written by
  `afk secrets put`.
- Secret _references_ live in `.afk.env` as `secret:<name>`. The reference syntax
  is canonical across Backends.
- `.afk.env` is gitignored by default. The CLI refuses to start if `.afk.env` is
  tracked by git.

A Run needs at minimum a `github-token` secret to clone source. Where values are
stored is Backend-specific — **SSM Parameter Store** on AWS, **Secret Manager**
on GCP, **Workers Secrets** on Cloudflare, a `~/.afk/secrets/` file on **Local**.
