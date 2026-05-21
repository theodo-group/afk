# Context

Glossary of the canonical terms used in this project. Implementation details do not belong here.

## Run

The unit of work in this system. A Run is one ephemeral execution of a developer-defined command (typically, but not necessarily, an AI agent) inside a container in the cloud.

A Run has a bounded lifetime: it starts when its entrypoint command begins and ends when that command exits. While alive, a developer may optionally attach to it to observe or intervene; attach is not required for a Run to be useful.

A Run is backed by exactly one ECS Task on AWS. The ECS Task is the implementation; the Run is the concept the developer interacts with through the CLI (`afk run`, `afk attach <run>`, `afk logs <run>`, `afk kill <run>`).

Not to be confused with: an ECS Task (AWS resource), a TodoWrite task (work item inside an agent), or an agent sub-task (delegated work inside Claude).

## Backend

A provider-specific implementation of the operations a Run depends on: launching a container, attaching an interactive shell, streaming logs, terminating. The CLI is written against a Backend interface so the user-facing surface (`afk run`, `afk attach`, …) stays identical across providers.

The persisted Backend in `afk.config.json` (set by `afk init --provider <name>`) is the default for every command. A per-command `--local` flag overrides it for that invocation only.

Backends:
- **AWS ECS** — first and only cloud Backend in v1.
- **GCP (GKE Autopilot)**, **Azure (Container Instances / Container Apps)** — anticipated future cloud Backends.
- **Local** — a peer Backend that launches the Run as a container on the developer's local Docker daemon instead of in the cloud. Same image, entrypoint, env, secrets, and lifecycle rules as the cloud Backends; differs only in where the container runs. Selected via `--local` on any command. Still requires `afk init` to have been run and Terraform to have been applied, because Local resolves `ssm:` secret references against the same SSM Parameter Store that the cloud Backend reads from.

## Owner

The IAM principal that launched a Run. Recorded as the `afk:owner` tag on the underlying ECS Task and used to scope what the developer can see, attach to, or terminate. A developer is normally only permitted to act on Runs whose Owner matches their own principal; team-wide views (`afk ls --all`) are a separate, broader permission.

## Dockerfile Contract

The set of rules a developer's `afk.Dockerfile` must follow for their image to be usable as a Run. The file lives at the repo root and is named `afk.Dockerfile` to namespace it away from any other Dockerfile the project uses for its own deployment. It installs the toolchain and dependencies needed by the Run's command, but does **not** copy the source code (the source is cloned at Run start by the entrypoint). The entrypoint script is owned by the CLI and injected at build time — the developer's `afk.Dockerfile` does not declare it.

## Ref

The git reference a Run executes against — a branch name, tag, or commit sha. Resolved against the project's configured `AFK_GIT_URL` at Run start. Passed via `afk run --ref <ref>`; defaults to the developer's current local branch name. A Run refuses to start if the resolved ref isn't reachable on origin.

