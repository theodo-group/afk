# Context

Glossary of the canonical terms used in this project. Implementation details do not belong here.

## Run

The unit of work in this system. A Run is one ephemeral execution of a developer-defined command (typically, but not necessarily, an AI agent) inside a container in the cloud.

A Run has a bounded lifetime: it starts when its entrypoint command begins and ends when that command exits. While alive, a developer may optionally attach to it to observe or intervene; attach is not required for a Run to be useful.

A Run is backed by exactly one cloud VM (an EC2 instance on AWS). The Run's workload executes as one or more containers on that VM's Docker daemon; the VM exists only for the duration of the Run and self-terminates when it ends. The VM is the implementation; the Run is the concept the developer interacts with through the CLI (`afk run`, `afk attach <run>`, `afk logs <run>`, `afk kill <run>`).

Not to be confused with: an EC2 instance (AWS resource), a TodoWrite task (work item inside an agent), or an agent sub-task (delegated work inside Claude).

## Backend

A provider-specific implementation of the operations a Run depends on: launching a container, attaching an interactive shell, streaming logs, terminating. The CLI is written against a Backend interface so the user-facing surface (`afk run`, `afk attach`, …) stays identical across providers.

The persisted Backend in `afk.config.json` (set by `afk init --provider <name>`) is the default for every command. A per-command `--local` flag overrides it for that invocation only.

Backends:
- **AWS EC2** — first and only cloud Backend in v1. Each Run is one EC2 instance booted from the project's [[golden-image]], configured via `user_data`, and self-terminated on exit.
- **GCP (Compute Engine)**, **Azure (Virtual Machines)** — anticipated future cloud Backends. Each is expected to follow the same one-VM-per-Run shape.
- **Local** — a peer Backend that launches the Run on the developer's local Docker daemon instead of in the cloud. Same image, entrypoint, env, secrets, and lifecycle rules as the cloud Backends; differs only in where the containers run. Selected via `--local` on any command.

## Owner

The IAM principal that launched a Run. Recorded as the `afk:owner` tag on the underlying EC2 instance and used to scope what the developer can see, attach to, or terminate. A developer is normally only permitted to act on Runs whose Owner matches their own principal; team-wide views (`afk ls --all`) are a separate, broader permission.

## Dockerfile Contract

The set of rules a developer's `afk.Dockerfile` must follow for their image to be usable as a Run. The file lives at the repo root and is named `afk.Dockerfile` to namespace it away from any other Dockerfile the project uses for its own deployment. It installs the toolchain and dependencies needed by the Run's command, but does **not** copy the source code (the source is cloned at Run start by the entrypoint). The entrypoint script is owned by the CLI and injected at build time — the developer's `afk.Dockerfile` does not declare it.

## Compose Contract

The (optional) rules a developer's `afk.compose.yml` must follow when a Run needs sidecar services (e.g. a Postgres, a Redis the agent talks to). The compose file lives at the repo root and declares a graph of services; one of them — the "main service," named in `afk.config.json` (default: `agent`) — is the agent itself, and its image is the one built from `afk.Dockerfile`. The Run's lifetime is the main service's lifetime; sidecars are torn down when it exits. The compose file is optional: a Run with no sidecars omits it entirely and the agent's image runs directly.

## Golden Image

A per-account, per-region VM image (an AMI on AWS) used as the boot image for every Run. Its sole purpose is to cache the Docker images the developer's Runs commonly pull (e.g. `postgres:16`, `redis:7`), so `docker compose up` inside a Run does not re-pull them from a registry each time. The Golden Image contains Docker itself and the developer-specified pre-pull list — nothing else. Run-time behavior (cloning source, running the workload, shipping logs, self-terminating) is injected fresh via `user_data` on each Run, not baked into the image.

Golden Images are built explicitly by `afk image build`, which reads the pre-pull list from `afk.config.json`. A Run refuses to start if no Golden Image exists in the account/region; there is no implicit on-demand build.

## Ref

The git reference a Run executes against — a branch name, tag, or commit sha. Resolved against the project's configured `AFK_GIT_URL` at Run start. Passed via `afk run --ref <ref>`; defaults to the developer's current local branch name. A Run refuses to start if the resolved ref isn't reachable on origin.

