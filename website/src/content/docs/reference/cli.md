---
title: CLI surface
description: The full afk command surface — setup, Golden Images, Runs, attach, logs, secrets, team management, and global flags.
---

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
afk session-artifact [--out <dir>] <run-id>    # download the Run's Session Artifact(s)
                                               #   writes to ./session-artifacts/ by default;
                                               #   collected best-effort from the main service at Run end;
                                               #   Owner-scoped like `afk logs`

afk secrets put <name> [value]                 # write to the active Backend's secret store
                                               #   - value omitted: prompts on stdin (hidden) OR reads stdin if piped
                                               #   - inline value: visible in `ps`; prefer stdin for real secrets
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

## Command semantics worth knowing

- `afk run "<command>"` and `afk run <command> <args…>` both work. The
  container's CMD becomes `sh -c "<joined command>"`, so quoting and shell
  features (`&&`, `|`, `$VARS`) work as you'd expect.
- The region a cloud command operates on comes from `afk.config.json` →
  `aws.region` / `gcp.region` (zone/machine type live in the `gcp` block). There
  is no per-command `--region` flag (apart from `afk init`, which writes the
  region into the rendered `backend.tf` and scaffolded config).
- `aws`, `gcp`, `cloudflare`, and `local` Backends are supported; Azure VMs are
  still anticipated. `--local` overrides the persisted backend for one
  invocation and may appear anywhere on the line.

All AWS calls go through the standard credential chain (`AWS_PROFILE`, env vars,
IMDS). Developers act under an IAM role provisioned by the Terraform. All
Cloudflare calls go through the launcher Worker, authenticated by a per-developer
Cloudflare Access service token (provisioned by `afk team add`) — the CLI never
talks to the CF control-plane API directly except during `afk init` /
`afk golden build`. The `team` commands require admin permissions on either
Backend.
