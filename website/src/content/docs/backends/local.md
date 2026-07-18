---
title: Local Backend
description: "Each Run on your own Docker daemon — a faithful rehearsal of the cloud path, fully self-contained."
---


The Local Backend runs each Run on the developer's **own Docker daemon** instead of the cloud — a faithful rehearsal of the cloud path (same image build, same entrypoint, same compose file, same secret resolution, same lifecycle). It mirrors the **Cloudflare** shape with the Cloudflare Container instance swapped for a Docker container on your machine: each Run is one outer container running **rootless `dockerd`**, booted from a local Golden Image, hosting the `docker compose` stack inside it. It is **fully self-contained** — it makes no cloud API calls and needs no cloud credentials.

See the [Quickstart](/afk/getting-started/quickstart/#on-local) for the setup commands.

## Selection — two channels

Unlike the cloud backends, Local is reachable both ways:

- **Persisted:** `afk init --provider local` writes `backend: "local"`, after which every command targets Local.
- **Per-command override:** pass `--local` on any command (e.g. `afk run --local "<cmd>"`) to use Local for that invocation regardless of the persisted backend. `--local` may appear anywhere on the line.

## How a Run executes

1. `afk build` / `afk run` builds the wrapped agent image into your local daemon (tag `local/afk/<repo>:<branch>-<sha>`); there is no registry push.
2. `afk run` launches one **`--privileged`** outer container from the local Golden Image, with a per-Run scratch dir bind-mounted in. The CLI `docker save`s the agent image onto that dir.
3. The outer container's bootstrap starts rootless `dockerd`, `docker load`s the agent image, and runs the workload (`docker compose up`, or `docker run` if there's no compose file) under the wall-clock timeout — the Run's lifetime is the main service's lifetime.
4. On exit the outer container exits with the workload's code; the host Docker daemon's record of that is the Run's terminal state. The exited container is preserved, so every Local Run is effectively [retained](/afk/concepts/glossary/#retention) — retaining a finished container on your own machine is free — until you remove it (`afk kill` / `docker rm`).

## Where state lives (all on your machine)

- **Live-Run truth source** — the host Docker daemon. Runs are containers labelled `afk.*` (the analogue of AWS's EC2 tags); `afk ls`/`kill`/`attach` resolve them via `docker ps`.
- **Secrets** — `afk secrets put` writes to a machine-global store under `~/.afk/secrets/` (one JSON file per project, keyed by `gitUrl`, mode `0600`). The CLI materialises values into the Run's env file at launch (no in-container fetch). The `secret:<name>` reference syntax is identical to every backend.
- **History** — a `~/.afk/history.jsonl` archive, reconciled lazily from the daemon on each `afk ls`/`history`/`logs` (no always-on supervisor). A Run pruned from the daemon before any CLI invocation keeps its last-seen state.
- **Logs** — the bootstrap streams per-service logs live to the bind-mounted scratch dir (`logs/<service>.log`, plus a prefixed `combined.log` for `--all`); `afk logs` reads them straight off disk, live and after exit.
- **Session Artifacts** — declared artifacts are staged at graceful exit into `~/.afk/runs/<id>/session-artifacts/` (mirroring the container's absolute layout), where `afk session-artifact <run-id>` reads them. Collection mechanics — caps, globs, best-effort semantics — are Backend-neutral; see [Session Artifacts](/afk/reference/configuration/#session-artifacts).

## Differences from the cloud backends

- The Golden Image is a container image built **into your local daemon** (never pushed); `afk golden build` (with the Local Backend active) produces it. A Run refuses to start until it exists.
- Honors the **Cloudflare** Compose Contract (rootless: auto-injected `network_mode: host` + `extra_hosts`), not the unconstrained AWS one. A privileged AWS-style Run is not faithfully rehearsable locally.
- `afk team` is unsupported (a single machine has one implicit Owner, `local`). `afk provision` is a no-op (nothing to stand up).
- `afk attach` shells into the nested service container via the outer container's docker; `--host` drops you on the outer container's shell.
- No automated timeout backstop (no cloud sweeper/alarm): a wedged Run relies on the in-container `timeout(1)` or a manual `afk kill`.

## Requirements

Just Docker. Nested dind requires the outer container to run `--privileged` (this is how `docker:dind-rootless` works), so a Docker daemon that permits privileged containers is needed.

## Teardown

Teardown is manual (so nothing on your machine is removed by surprise):

```sh
docker rmi $(docker images 'afk-golden-local' -q)   # Golden Image(s)
rm -rf ~/.afk                                        # history + secrets
# Live Runs (if any) are ordinary containers — `afk kill <run>`.
```
