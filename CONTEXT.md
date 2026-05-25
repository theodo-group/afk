# Context

Glossary of the canonical terms used in this project. Implementation details do not belong here.

## Run

The unit of work in this system. A Run is one ephemeral execution of a developer-defined command (typically, but not necessarily, an AI agent) inside a container in the cloud.

A Run has a bounded lifetime: it starts when its entrypoint command begins and ends when that command exits. While alive, a developer may optionally attach to it to observe or intervene; attach is not required for a Run to be useful.

A Run is backed by exactly one **compute primitive** in the active [[backend]]: an EC2 instance on AWS, a Container instance on Cloudflare, etc. The Run's workload executes as one or more containers — on the VM's host Docker daemon on AWS, or inside rootless `dind` on Cloudflare. When the Run ends its compute primitive is either reclaimed immediately or, on Backends that support [[retention]], held in a retained state until resumed or reclaimed. The compute primitive is the implementation; the Run is the concept the developer interacts with through the CLI (`afk run`, `afk attach <run>`, `afk logs <run>`, `afk kill <run>`).

Not to be confused with: an EC2 instance / Container instance (provider resources), a TodoWrite task (work item inside an agent), or an agent sub-task (delegated work inside Claude).

## Run Plan

The fully-resolved description of a [[run]] before any compute primitive is launched: the resolved image, [[ref]], command, timeout, environment, secret references, and (if present) the linted [[compose-contract]] graph. A Run Plan is the output of resolving a developer's request against `afk.config.json` and the built image — deterministic and side-effect-free to compute.

It is the thing `afk run --dry-run` prints: the developer sees exactly what would launch without anything being launched. The [[backend]] is split so this resolution (`prepare`) is separable from the irreversible launch step, and the backend-neutral core of the plan (env, secrets, timeout, compose) is assembled identically regardless of [[backend]]; only the launch-vehicle specifics (instance type/tier, boot script, registry coordinates) are filled in per-Backend.

Not to be confused with the launch itself: a Run Plan describes intent; launching it creates the compute primitive that makes it a live Run.

## Retention

After a [[run]] ends, a [[backend]] may **retain** its compute primitive instead of reclaiming it: the primitive is stopped but preserved, holding the finished workload's state. A **retained** Run does no work — its command has already exited — but can be **resumed**: `afk attach` on a retained Run brings the compute primitive back up and drops the developer into it to inspect the post-mortem state. Resume lasts only for the duration of that attach session — when the developer detaches, the primitive returns to the retained state, so a finished Run's one resting state is always retained. Retention exists so a fast Run can still be inspected after the fact instead of vanishing the instant its command exits.

Resuming revives only the compute primitive, never the workload — the Run has already ended, so resume re-animates the host so attach has something to enter; it does not re-run the developer's command. A retained Run is reclaimed explicitly by `afk kill`, or automatically once it is older than the configured **retention period** (default 7 days) — so retained is a bounded grace window, not permanent storage.

Realized on the [[backend|Local Backend]] only, where every Run is retained — Local runs on no capacity-pricing model, so retaining a finished container is free. The cloud Backends do **not** retain: AWS and GCP default to [[spot|Spot]] capacity, which cannot be stopped without losing its disk, so every cloud Run self-terminates on exit. Cloudflare reclaims immediately too — its Container instances are ephemeral, so a restarted one is a clean slate rather than preserved post-mortem state, the opposite of what retention promises.

Post-mortem inspection of a finished cloud Run is therefore not available: on the cloud Backends `afk attach` only enters a Run that is still **live** (its command has not yet exited). To carry state past a cloud Run's end, declare a [[session-artifact]].

Not to be confused with a suspended or paused Run (there is no such state — a Run that has ended has ended) or with `afk kill` (which reclaims, the opposite of retain).

## Spot

The capacity model a cloud [[run]] launches under. **Spot** is interruptible, heavily discounted capacity the provider may reclaim at any time (an AWS Spot instance, a GCP `SPOT` VM); **On-Demand** is full-price capacity the provider does not reclaim. A cloud Run defaults to Spot — the common case is cheap and disposable — and `--on-demand` opts up to On-Demand.

The only thing the choice changes is **interruption risk**: a Spot reclaim kills a live Run mid-flight, so a long or fragile Run pays for On-Demand to avoid that. It does **not** change end-of-life — both self-terminate on exit, neither is retained (see [[retention]]). Spot is a cloud-only concept; the Local Backend has no capacity model.

Not to be confused with [[retention]] (Spot once implied "non-retainable," but retention is now Local-only, so the two are independent) or with the [[golden-image]] (the boot artifact, orthogonal to how the instance is purchased).

## Backend

A provider-specific implementation of the operations a Run depends on: launching a container, attaching an interactive shell, streaming logs, terminating. The CLI is written against a Backend interface so the user-facing surface (`afk run`, `afk attach`, …) stays identical across providers.

The persisted Backend in `afk.config.json` (set by `afk init --provider <name>`) is the default for every command. The Local Backend is special among Backends in being reachable through two channels: it can be the persisted Backend (`afk init --provider local`) like any other, _and_ a per-command `--local` flag selects it for that invocation only regardless of the persisted Backend.

Backends:

- **AWS EC2** — shipped. Each Run is one EC2 instance booted from the project's [[golden-image]], configured via `user_data`, and self-terminated on exit (no [[retention]]). Defaults to [[spot|Spot]] capacity; `--on-demand` selects On-Demand for interruption-resistance, not for any difference in end-of-life. Full Compose Contract supported (host Docker daemon, real bridge networking, privileged-capable). A sweeper Lambda terminates only instances that overran their timeout (the crash backstop — AWS has no native max-run-duration) and reconciles orphaned history rows; with [[retention]] gone there are no stopped instances to reap.
- **Cloudflare Containers** — shipped. Each Run is one Cloudflare Container instance bound to a Durable Object inside a customer-deployed launcher Worker. Runs `dockerd` rootless inside the Container to host the workload. Compose Contract honored under additional per-backend rules (rootless-only images, `network_mode: host`, no privileged).
- **GCP (Compute Engine)** — planned, AWS-shaped. Each Run is one Compute Engine instance booted from the project's [[golden-image]] (a custom image), configured via the startup-script, and self-deleted on exit (the instance's service account is scoped to delete only afk-managed VMs), with GCE's native `max_run_duration` as the timeout backstop. Defaults to [[spot|Spot]] capacity (`provisioningModel: SPOT`, not legacy preemptible); `--on-demand` selects `STANDARD`. Preemption and timeout both end in instance DELETE, so there is no [[retention]] and no extra teardown path. Full Compose Contract supported (host Docker daemon). [[owner|Owner]] is the authenticated gcloud account; attach rides Identity-Aware Proxy TCP tunnelling + OS Login so instances need no inbound SSH. A minimal Cloud Function (on Cloud Scheduler) reconciles orphaned history rows only — it does not reclaim VMs.
- **Azure (Virtual Machines)** — anticipated future cloud Backend, expected to follow the same one-VM-per-Run shape as AWS.
- **Local** — a peer Backend that mirrors the Cloudflare shape with the Cloudflare Container instance swapped for a Docker container on the developer's own machine. Each Run is one outer container running rootless `dockerd`, booted from a local [[golden-image]], hosting the `docker compose` stack inside it — so it honors the same Compose addenda and rootless constraints as Cloudflare. Fully self-contained: it makes no cloud API calls and needs no cloud credentials (secrets, history, and the Run index all live on the developer's machine). Selectable both as the persisted Backend (`afk init --provider local`) and per-command via `--local`.

## Owner

The developer principal that launched a Run. The form of the principal is [[backend]]-specific — an IAM userid on AWS, a Cloudflare Access service-token client-id on Cloudflare, the authenticated gcloud account (user or service-account email) on GCP — but the role is the same: it scopes what the developer can see, attach to, or terminate. The Owner is recorded on the underlying compute primitive (an `afk:owner` EC2 tag on AWS, a metadata field on the launcher Worker's [[run-registry]] on Cloudflare, an `afk-owner` label on the Compute Engine instance on GCP). A developer is normally only permitted to act on Runs whose Owner matches their own principal; team-wide views (`afk ls --all`) are a separate, broader permission.

## Dockerfile Contract

The set of rules a developer's `afk.Dockerfile` must follow for their image to be usable as a Run. The file lives at the repo root and is named `afk.Dockerfile` to namespace it away from any other Dockerfile the project uses for its own deployment. It installs the toolchain and dependencies needed by the Run's command, but does **not** copy the source code (the source is cloned at Run start by the entrypoint). The entrypoint script is owned by the CLI and injected at build time — the developer's `afk.Dockerfile` does not declare it.

## Compose Contract

The (optional) rules a developer's `afk.compose.yml` must follow when a Run needs sidecar services (e.g. a Postgres, a Redis the agent talks to). The compose file lives at the repo root and declares a graph of services; one of them — the "main service," named in `afk.config.json` (default: `agent`) — is the agent itself, and its image is the one built from `afk.Dockerfile`. The Run's lifetime is the main service's lifetime: when it exits the Run ends and its sidecars stop with it. Their containers and volumes are reclaimed with the compute primitive — immediately, or, where [[retention]] applies, preserved until the retained primitive is reclaimed so the whole stack can be inspected post-mortem. The compose file is optional: a Run with no sidecars omits it entirely and the agent's image runs directly.

The compose file is portable across [[backend]]s without dev changes. Some Backends impose structural addenda that the CLI applies automatically at submit time — e.g. on the Cloudflare Backend, every service is augmented with `network_mode: host` and `extra_hosts` cross-mappings so service-name DNS keeps working under rootless `dind`. The only Compose Contract rule that the CLI cannot auto-fix is port collision between sidecars of the same Run, which remains a hard error.

## Golden Image

The per-account, per-[[backend]] **boot artifact** used by every Run. Its sole purpose is to pre-cache the Docker engine plus a developer-specified list of sidecar images (e.g. `postgres:16`, `redis:7`), so per-Run cold-starts don't re-pull them.

The concrete artifact type is Backend-specific:

- On **AWS EC2**, the Golden Image is an **AMI** (a VM disk image) containing Amazon Linux + Docker + the pre-pulled images in `/var/lib/docker`.
- On **Cloudflare Containers**, the Golden Image is a **Container image** (pushed to CF managed registry) containing rootless `dockerd` + the pre-pulled images baked into `/var/afk/cache/`.
- On **Local**, the Golden Image is a **Container image** of the same shape as Cloudflare's (rootless `dockerd` + pre-pulled cache), built into the developer's own Docker daemon rather than pushed to a registry. It is the boot artifact for the outer dind container that backs each local Run.
- On **GCP (Compute Engine)**, the Golden Image is a **custom image** (a VM disk image, the AMI analog) containing the OS + Docker + the pre-pulled images, built by snapshotting a short-lived builder instance's disk after it pre-pulls the list.

Despite the artifact difference, the role is identical: it's the layer below the dev's per-build agent image, providing the runtime engine + sidecar cache. Run-time behavior (cloning source, running the workload, shipping logs, self-terminating) is injected fresh per Run, not baked into the Golden Image.

Golden Images are built explicitly by `afk golden build`, which reads the pre-pull list from the active backend's section of `afk.config.json`. A Run refuses to start if no Golden Image exists for the active Backend; there is no implicit on-demand build.

## Ref

The git reference a Run executes against — a branch name, tag, or commit sha. Resolved against the project's configured `AFK_GIT_URL` at Run start. Passed via `afk run --ref <ref>`; defaults to the developer's current local branch name. A Run refuses to start if the resolved ref isn't reachable on origin.

## Session Artifact

A developer-declared file (or glob of files) produced _inside the [[run]]'s main service container_ that afk collects when the Run ends and persists for later review — the motivating case being an AI agent's structured session transcript (e.g. Claude Code's `~/.claude/projects/**/*.jsonl`), so a developer can reconstruct what the agent did after the fact.

afk is agent-agnostic and therefore knows nothing about the artifact's shape or meaning: the developer names the path(s) in `afk.config.json`, and afk treats the contents as an opaque blob. Collection is scoped to the **main service** only — never sidecars — which is what distinguishes a Session Artifact from general file exfiltration out of an arbitrary container.

Distinct from **logs**: logs are the per-service stdout/stderr stream tailed live by `afk logs`; a Session Artifact is a file collected once, at Run end, from the agent's own on-disk state. A Run with no declared Session Artifacts collects nothing — the feature is opt-in.

The single collection point — the Run command's graceful exit — also bounds what is captured, on every [[backend]]: a Session Artifact is the artifact of *the Run's own execution*, not of any later [[attach]] session. Running a fresh agent inside an `afk attach` shell and then exiting happens outside that one collection moment, so it is never captured. Attach is for observing and intervening on a Run; reconstructing an attach session is outside the Session Artifact's scope.
