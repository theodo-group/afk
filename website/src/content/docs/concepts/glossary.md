---
title: Glossary
description: The canonical vocabulary used throughout AFK — Run, Run Plan, Retention, Spot, Backend, Owner, the Contracts, Golden Image, Ref, and Session Artifact.
---

The canonical terms used throughout AFK. This is the source of truth for the
project's vocabulary; implementation details live in the [Backend
docs](/backends/overview/).

## Run

The unit of work in this system. A Run is one ephemeral execution of a
developer-defined command (typically, but not necessarily, an AI agent) inside a
container in the cloud.

A Run has a bounded lifetime: it starts when its entrypoint command begins and
ends when that command exits. While alive, a developer may optionally attach to
observe or intervene; attach is not required for a Run to be useful.

A Run is backed by exactly one **compute primitive** in the active
[Backend](#backend): an EC2 instance on AWS, a Container instance on Cloudflare,
etc. The Run's workload executes as one or more containers — on the VM's host
Docker daemon on AWS, or inside rootless `dind` on Cloudflare. When the Run ends
its compute primitive is either reclaimed immediately or, on Backends that
support [Retention](#retention), held in a retained state until resumed or
reclaimed. The compute primitive is the implementation; the Run is the concept
the developer interacts with through the CLI (`afk run`, `afk attach <run>`,
`afk logs <run>`, `afk kill <run>`).

Not to be confused with: an EC2 instance / Container instance (provider
resources), a TodoWrite task (work item inside an agent), or an agent sub-task
(delegated work inside Claude).

## Run Plan

The fully-resolved description of a Run before any compute primitive is launched:
the resolved image, [Ref](#ref), command, timeout, environment, secret
references, and (if present) the linted [Compose Contract](#compose-contract)
graph. A Run Plan is the output of resolving a developer's request against
`afk.config.json` and the built image — deterministic and side-effect-free to
compute.

It is the thing `afk run --dry-run` prints: the developer sees exactly what would
launch without anything being launched. The Backend is split so this resolution
(`prepare`) is separable from the irreversible launch step, and the
backend-neutral core of the plan (env, secrets, timeout, compose) is assembled
identically regardless of Backend; only the launch-vehicle specifics (instance
type/tier, boot script, registry coordinates) are filled in per-Backend.

Not to be confused with the launch itself: a Run Plan describes intent;
launching it creates the compute primitive that makes it a live Run.

## Retention

After a Run ends, a Backend may **retain** its compute primitive instead of
reclaiming it: the primitive is stopped but preserved, holding the finished
workload's state. A **retained** Run does no work — its command has already
exited — but can be **resumed**: `afk attach` on a retained Run brings the
compute primitive back up and drops the developer into it to inspect the
post-mortem state. Resume lasts only for the duration of that attach session —
when the developer detaches, the primitive returns to the retained state, so a
finished Run's one resting state is always retained.

Resuming revives only the compute primitive, never the workload — the Run has
already ended, so resume re-animates the host so attach has something to enter;
it does not re-run the developer's command. A retained Run is reclaimed
explicitly by `afk kill`, or automatically once it is older than the configured
**retention period** (default 7 days).

Realized on the **Local Backend** only, where every Run is retained — Local runs
on no capacity-pricing model, so retaining a finished container is free. The
cloud Backends do **not** retain: AWS and GCP default to [Spot](#spot) capacity,
which cannot be stopped without losing its disk, so every cloud Run
self-terminates on exit. Cloudflare reclaims immediately too.

Post-mortem inspection of a finished cloud Run is therefore not available: on the
cloud Backends `afk attach` only enters a Run that is still **live** (its command
has not yet exited). To carry state past a cloud Run's end, declare a [Session
Artifact](#session-artifact).

## Spot

The capacity model a cloud Run launches under. **Spot** is interruptible,
heavily discounted capacity the provider may reclaim at any time (an AWS Spot
instance, a GCP `SPOT` VM); **On-Demand** is full-price capacity the provider
does not reclaim. A cloud Run defaults to Spot — the common case is cheap and
disposable — and `--on-demand` opts up to On-Demand.

The only thing the choice changes is **interruption risk**: a Spot reclaim kills
a live Run mid-flight, so a long or fragile Run pays for On-Demand to avoid that.
It does **not** change end-of-life — both self-terminate on exit, neither is
retained. Spot is a cloud-only concept; the Local Backend has no capacity model.

## Backend

A provider-specific implementation of the operations a Run depends on: launching
a container, attaching an interactive shell, streaming logs, terminating. The
CLI is written against a Backend interface so the user-facing surface (`afk run`,
`afk attach`, …) stays identical across providers.

The persisted Backend in `afk.config.json` (set by `afk init --provider <name>`)
is the default for every command. The Local Backend is special in being reachable
through two channels: it can be the persisted Backend (`afk init --provider
local`) like any other, _and_ a per-command `--local` flag selects it for that
invocation only regardless of the persisted Backend.

The four shipped Backends — AWS EC2, GCP Compute Engine, Cloudflare Containers,
and Local — plus the anticipated Azure Backend are detailed in the [Backends
overview](/backends/overview/).

## Owner

The developer principal that launched a Run. The form of the principal is
Backend-specific — an IAM userid on AWS, a Cloudflare Access service-token
client-id on Cloudflare, the authenticated gcloud account on GCP — but the role
is the same: it scopes what the developer can see, attach to, or terminate. The
Owner is recorded on the underlying compute primitive (an `afk:owner` EC2 tag on
AWS, a metadata field on the launcher Worker's run registry on Cloudflare, an
`afk-owner` label on the Compute Engine instance on GCP). A developer is normally
only permitted to act on Runs whose Owner matches their own principal; team-wide
views (`afk ls --all`) are a separate, broader permission.

## Dockerfile Contract

The set of rules a developer's `afk.Dockerfile` must follow for their image to be
usable as a Run. The file lives at the repo root and is named `afk.Dockerfile` to
namespace it away from any other Dockerfile the project uses for its own
deployment. It installs the toolchain and dependencies needed by the Run's
command, but does **not** copy the source code (the source is cloned at Run start
by the entrypoint). The entrypoint script is owned by the CLI and injected at
build time — the developer's `afk.Dockerfile` does not declare it.

See [Consumer contract](/reference/consumer-contract/) for the full rules and an
example.

## Compose Contract

The (optional) rules a developer's `afk.compose.yml` must follow when a Run needs
sidecar services (e.g. a Postgres, a Redis the agent talks to). The compose file
lives at the repo root and declares a graph of services; one of them — the "main
service," named in `afk.config.json` (default: `agent`) — is the agent itself,
and its image is the one built from `afk.Dockerfile`. The Run's lifetime is the
main service's lifetime: when it exits the Run ends and its sidecars stop with
it.

The compose file is portable across Backends without dev changes. Some Backends
impose structural addenda that the CLI applies automatically at submit time —
e.g. on the Cloudflare Backend, every service is augmented with
`network_mode: host` and `extra_hosts` cross-mappings so service-name DNS keeps
working under rootless `dind`. The only Compose Contract rule the CLI cannot
auto-fix is port collision between sidecars of the same Run, which remains a hard
error.

## Golden Image

The per-account, per-Backend **boot artifact** used by every Run. Its sole
purpose is to pre-cache the Docker engine plus a developer-specified list of
sidecar images (e.g. `postgres:16`, `redis:7`), so per-Run cold-starts don't
re-pull them.

The concrete artifact type is Backend-specific:

- On **AWS EC2**, the Golden Image is an **AMI** (a VM disk image) containing
  Amazon Linux + Docker + the pre-pulled images in `/var/lib/docker`.
- On **Cloudflare Containers**, the Golden Image is a **Container image** (pushed
  to CF managed registry) containing rootless `dockerd` + the pre-pulled images
  baked into `/var/afk/cache/`.
- On **Local**, the Golden Image is a **Container image** of the same shape as
  Cloudflare's, built into the developer's own Docker daemon rather than pushed
  to a registry.
- On **GCP (Compute Engine)**, the Golden Image is a **custom image** (a VM disk
  image, the AMI analog) built by snapshotting a short-lived builder instance's
  disk after it pre-pulls the list.

Golden Images are built explicitly by `afk golden build`, which reads the
pre-pull list from the active Backend's section of `afk.config.json`. A Run
refuses to start if no Golden Image exists for the active Backend; there is no
implicit on-demand build.

## Ref

The git reference a Run executes against — a branch name, tag, or commit sha.
Resolved against the project's configured `AFK_GIT_URL` at Run start. Passed via
`afk run --ref <ref>`; defaults to the developer's current local branch name. A
Run refuses to start if the resolved ref isn't reachable on origin.

## Session Artifact

A developer-declared file (or glob of files) produced _inside the Run's main
service container_ that afk collects when the Run ends and persists for later
review — the motivating case being an AI agent's structured session transcript
(e.g. Claude Code's `~/.claude/projects/**/*.jsonl`), so a developer can
reconstruct what the agent did after the fact.

afk is agent-agnostic and therefore knows nothing about the artifact's shape or
meaning: the developer names the path(s) in `afk.config.json`, and afk treats the
contents as an opaque blob. Collection is scoped to the **main service** only —
never sidecars — which is what distinguishes a Session Artifact from general file
exfiltration out of an arbitrary container.

Distinct from **logs**: logs are the per-service stdout/stderr stream tailed live
by `afk logs`; a Session Artifact is a file collected once, at Run end, from the
agent's own on-disk state. The single collection point — the Run command's
graceful exit — also bounds what is captured: a Session Artifact is the artifact
of _the Run's own execution_, not of any later attach session.
