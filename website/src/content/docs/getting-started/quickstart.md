---
title: Quickstart
description: Stand up your first Run on Local, AWS, GCP, or Cloudflare — the CLI surface is identical from there.
---

Pick a Backend; the CLI surface is identical from there. **Local** needs only
Docker and zero cloud setup, so it's the fastest way to see a Run.

Already configured for a cloud Backend? Add `--local` to any command to rehearse
a Run on your own daemon (after a one-time `afk golden build --local`).

## On Local

In any repo with an `afk.Dockerfile`:

```sh
afk init --provider local                     # configure (writes backend=local)
afk golden build                              # one-time: build the local runtime image
afk secrets put github-token <PAT>            # stored under ~/.afk/secrets/, keyed by gitUrl
echo "GITHUB_TOKEN=secret:github-token" >> .afk.env

afk run "claude -p 'fix the failing test and open a PR'"
afk ls
afk logs <run-id>
```

Teardown is manual — see the [Local backend doc](/afk/backends/local/).

## On AWS

In a fresh consumer repo:

```sh
afk init --provider aws --region eu-west-1   # creates the state bucket + scaffolds files
afk provision                                # terraform apply: VPC, IAM, sweeper Lambda, DynamoDB
afk golden build                             # one-time per account/region (~5 min)
afk secrets put github-token <PAT>           # a GitHub PAT so the VM can clone source
echo "GITHUB_TOKEN=secret:github-token" >> .afk.env

# Author + push your contract files (afk.Dockerfile, optional afk.compose.yml).
git add afk.Dockerfile afk.compose.yml afk.config.json && git commit -m "configure AFK" && git push
afk run bun --version
afk ls && afk logs <run-id>
```

Teardown: `afk destroy` (dry-run) / `afk destroy --yes`. See the
[AWS backend doc](/afk/backends/aws/) for exactly what is removed.

## On GCP

Same one-VM-per-Run shape as AWS — a Compute Engine instance per Run, booted
from a custom-image Golden Image, self-deleted on exit. Differences: attach
rides an IAP TCP tunnel (no public IP, no SSH) and the Owner is your
authenticated gcloud account.

In a fresh consumer repo (after `gcloud auth login` and
`gcloud config set project <id>`):

```sh
afk init --provider gcp --region us-central1  # resolves the project, creates the GCS state bucket + scaffolds files
afk provision                                 # terraform apply: APIs, VPC + NAT + IAP, SAs, Firestore, Artifact Registry, reconcile Cloud Function
afk golden build                              # one-time per project (~5 min): snapshots a builder VM into a custom image
afk secrets put github-token <PAT>            # a GitHub PAT (Secret Manager) so the VM can clone source
echo "GITHUB_TOKEN=secret:github-token" >> .afk.env

# Author + push your contract files (same as AWS), then launch.
git add afk.Dockerfile afk.compose.yml afk.config.json && git commit -m "configure AFK" && git push
afk run bun --version                         # Spot capacity by default; --on-demand for interruption-resistance
afk ls && afk logs <run-id>
```

Teardown: `afk destroy` (dry-run) / `afk destroy --yes`. See the
[GCP backend doc](/afk/backends/gcp/) for exactly what is removed.

## On Cloudflare

The CF Backend uses **rootless Docker-in-Docker** inside one Container instance
per Run, gated by a customer-deployed **launcher Worker**. Different topology
from AWS; same `afk` CLI surface. Skim the [Cloudflare backend
doc](/afk/backends/cloudflare/) before your first deploy.

Prerequisites: a Workers Paid plan, `wrangler` on PATH, and a
`CLOUDFLARE_API_TOKEN` in a gitignored `.env`.

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

:::note[Auth]
The CLI authenticates to the launcher Worker with Cloudflare Access
service-token headers, or a shared bearer (`AFK_SHARED_TOKEN`) for single-dev
mode. Production deploys should wrap the Worker URL in a Cloudflare Access
application and use `afk team add`.
:::

Teardown: `afk destroy --yes` (golden images, launcher Worker + DOs, Container
app, D1, KV). See the [Cloudflare backend doc](/afk/backends/cloudflare/).

## Interactive Runs and post-mortems

Two variations once the basics work, both detailed in the
[glossary](/afk/concepts/glossary/#interactive-run):

- **`afk session`** launches an [Interactive
  Run](/afk/concepts/glossary/#interactive-run) — a box with no command that you
  attach into and drive by hand. On-Demand by default (a Spot reclaim would kill
  your session); ends via `afk kill` or its timeout (default 24h).
- **`afk run --retain`** (AWS/GCP, implies On-Demand) stops the instance instead
  of terminating it when the Run ends, so `afk attach` can resume it later for
  [post-mortem inspection](/afk/concepts/glossary/#retention). Reclaimed after the
  retention period (default 7 days).
