# Context

Glossary of the canonical terms used in this project. Implementation details do not belong here.

## Run

The unit of work in this system. A Run is one ephemeral execution of a developer-defined command (typically, but not necessarily, an AI agent) inside a container in the cloud.

A Run has a bounded lifetime: it starts when its entrypoint command begins and ends when that command exits. While alive, a developer may optionally attach to it to observe or intervene; attach is not required for a Run to be useful.

A Run is backed by exactly one **compute primitive** in the active [[backend]]: an EC2 instance on AWS, a Container instance on Cloudflare, etc. The Run's workload executes as one or more containers — on the VM's host Docker daemon on AWS, or inside rootless `dind` on Cloudflare. That compute primitive exists only for the duration of the Run and is reclaimed when it ends. The compute primitive is the implementation; the Run is the concept the developer interacts with through the CLI (`afk run`, `afk attach <run>`, `afk logs <run>`, `afk kill <run>`).

Not to be confused with: an EC2 instance / Container instance (provider resources), a TodoWrite task (work item inside an agent), or an agent sub-task (delegated work inside Claude).

## Run Plan

The fully-resolved description of a [[run]] before any compute primitive is launched: the resolved image, [[ref]], command, timeout, environment, secret references, and (if present) the linted [[compose-contract]] graph. A Run Plan is the output of resolving a developer's request against `afk.config.json` and the built image — deterministic and side-effect-free to compute.

It is the thing `afk run --dry-run` prints: the developer sees exactly what would launch without anything being launched. The [[backend]] is split so this resolution (`prepare`) is separable from the irreversible launch step, and the backend-neutral core of the plan (env, secrets, timeout, compose) is assembled identically regardless of [[backend]]; only the launch-vehicle specifics (instance type/tier, boot script, registry coordinates) are filled in per-Backend.

Not to be confused with the launch itself: a Run Plan describes intent; launching it creates the compute primitive that makes it a live Run.

## Backend

A provider-specific implementation of the operations a Run depends on: launching a container, attaching an interactive shell, streaming logs, terminating. The CLI is written against a Backend interface so the user-facing surface (`afk run`, `afk attach`, …) stays identical across providers.

The persisted Backend in `afk.config.json` (set by `afk init --provider <name>`) is the default for every command. The Local Backend is special among Backends in being reachable through two channels: it can be the persisted Backend (`afk init --provider local`) like any other, *and* a per-command `--local` flag selects it for that invocation only regardless of the persisted Backend.

Backends:
- **AWS EC2** — shipped. Each Run is one EC2 instance booted from the project's [[golden-image]], configured via `user_data`, and self-terminated on exit. Full Compose Contract supported (host Docker daemon, real bridge networking, privileged-capable).
- **Cloudflare Containers** — shipped. Each Run is one Cloudflare Container instance bound to a Durable Object inside a customer-deployed launcher Worker. Runs `dockerd` rootless inside the Container to host the workload. Compose Contract honored under additional per-backend rules (rootless-only images, `network_mode: host`, no privileged).
- **GCP (Compute Engine)**, **Azure (Virtual Machines)** — anticipated future cloud Backends. Each is expected to follow the same one-VM-per-Run shape as AWS.
- **Local** — a peer Backend that mirrors the Cloudflare shape with the Cloudflare Container instance swapped for a Docker container on the developer's own machine. Each Run is one outer container running rootless `dockerd`, booted from a local [[golden-image]], hosting the `docker compose` stack inside it — so it honors the same Compose addenda and rootless constraints as Cloudflare. Fully self-contained: it makes no cloud API calls and needs no cloud credentials (secrets, history, and the Run index all live on the developer's machine). Selectable both as the persisted Backend (`afk init --provider local`) and per-command via `--local`.

## Owner

The developer principal that launched a Run. The form of the principal is [[backend]]-specific — an IAM userid on AWS, a Cloudflare Access service-token client-id on Cloudflare — but the role is the same: it scopes what the developer can see, attach to, or terminate. The Owner is recorded on the underlying compute primitive (an `afk:owner` EC2 tag on AWS, a metadata field on the launcher Worker's [[run-registry]] on Cloudflare). A developer is normally only permitted to act on Runs whose Owner matches their own principal; team-wide views (`afk ls --all`) are a separate, broader permission.

## Dockerfile Contract

The set of rules a developer's `afk.Dockerfile` must follow for their image to be usable as a Run. The file lives at the repo root and is named `afk.Dockerfile` to namespace it away from any other Dockerfile the project uses for its own deployment. It installs the toolchain and dependencies needed by the Run's command, but does **not** copy the source code (the source is cloned at Run start by the entrypoint). The entrypoint script is owned by the CLI and injected at build time — the developer's `afk.Dockerfile` does not declare it.

## Compose Contract

The (optional) rules a developer's `afk.compose.yml` must follow when a Run needs sidecar services (e.g. a Postgres, a Redis the agent talks to). The compose file lives at the repo root and declares a graph of services; one of them — the "main service," named in `afk.config.json` (default: `agent`) — is the agent itself, and its image is the one built from `afk.Dockerfile`. The Run's lifetime is the main service's lifetime; sidecars are torn down when it exits. The compose file is optional: a Run with no sidecars omits it entirely and the agent's image runs directly.

The compose file is portable across [[backend]]s without dev changes. Some Backends impose structural addenda that the CLI applies automatically at submit time — e.g. on the Cloudflare Backend, every service is augmented with `network_mode: host` and `extra_hosts` cross-mappings so service-name DNS keeps working under rootless `dind`. The only Compose Contract rule that the CLI cannot auto-fix is port collision between sidecars of the same Run, which remains a hard error.

## Golden Image

The per-account, per-[[backend]] **boot artifact** used by every Run. Its sole purpose is to pre-cache the Docker engine plus a developer-specified list of sidecar images (e.g. `postgres:16`, `redis:7`), so per-Run cold-starts don't re-pull them.

The concrete artifact type is Backend-specific:
- On **AWS EC2**, the Golden Image is an **AMI** (a VM disk image) containing Amazon Linux + Docker + the pre-pulled images in `/var/lib/docker`.
- On **Cloudflare Containers**, the Golden Image is a **Container image** (pushed to CF managed registry) containing rootless `dockerd` + the pre-pulled images baked into `/var/afk/cache/`.
- On **Local**, the Golden Image is a **Container image** of the same shape as Cloudflare's (rootless `dockerd` + pre-pulled cache), built into the developer's own Docker daemon rather than pushed to a registry. It is the boot artifact for the outer dind container that backs each local Run.

Despite the artifact difference, the role is identical: it's the layer below the dev's per-build agent image, providing the runtime engine + sidecar cache. Run-time behavior (cloning source, running the workload, shipping logs, self-terminating) is injected fresh per Run, not baked into the Golden Image.

Golden Images are built explicitly by `afk golden build`, which reads the pre-pull list from the active backend's section of `afk.config.json`. A Run refuses to start if no Golden Image exists for the active Backend; there is no implicit on-demand build.

## Ref

The git reference a Run executes against — a branch name, tag, or commit sha. Resolved against the project's configured `AFK_GIT_URL` at Run start. Passed via `afk run --ref <ref>`; defaults to the developer's current local branch name. A Run refuses to start if the resolved ref isn't reachable on origin.

