---
title: Consumer contract
description: The files a repo must provide to run under AFK — afk.Dockerfile, the optional afk.compose.yml, afk.config.json, and .afk.env.
---

A repo that wants to use AFK must provide the files below.

## 1. `afk.Dockerfile` (required)

The file **must** be named `afk.Dockerfile` so it is namespaced away from any
other Dockerfile the project uses for its own deployment.

- Installs the toolchain and dependencies needed by the Run's command.
- **Does not `COPY` source code.** Source is cloned at Run start — see [How it
  works](/getting-started/how-it-works/#source-code-handling).
- **Does not declare `ENTRYPOINT`.** The CLI injects one at build time.
- Leaves `/workspace` writable. The entrypoint clones source there.

Minimal example:

```dockerfile
FROM node:20
RUN apt-get update && apt-get install -y git
RUN npm install -g @anthropic-ai/claude-code
WORKDIR /workspace
```

For a fuller starting point (Bun, common build utilities, clear extension
points), see the [Claude Code recipe](https://github.com/theodo-group/afk/blob/main/docs/recipes/claude-code.dockerfile).

## 2. `afk.compose.yml` (optional)

When the Run needs sidecar services, declare them in a compose file. One service
— the "main service," named in `afk.config.json` (default: `agent`) — is the
agent; its image must be `${AFK_IMAGE}` (the CLI substitutes the agent image's
registry URI at submit time). Other services are stock images.

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

The CLI exports three shell variables before invoking `docker compose up` on the
Run's compute primitive, which compose substitutes into the file above:

- **`AFK_IMAGE`** — the registry URI (or local tag) of the wrapped agent image
  the CLI just built.
- **`AFK_COMMAND`** — the command from `afk run <args…>` as a shell-quoted
  string. If the dev's main service hardcodes `command:`, that wins instead.
- **`AFK_ENV_FILE`** — path to a file containing every value from `.afk.env` plus
  AFK-injected variables (`AFK_GIT_URL`, `AFK_GIT_REF`, `AFK_RUN_ID`,
  `AFK_TIMEOUT_SECONDS`, decrypted secrets). The main service must reference it
  via `env_file:` to receive them.

Restrictions enforced by the CLI at submit time:

- No `restart: always` or `restart: unless-stopped` on the main service (would
  fight Run-ends-on-exit semantics).
- `ports:` on any service generates a warning — inbound is unreachable at the
  network level on every Backend.
- The main service must reference `${AFK_IMAGE}`.
- Missing `env_file:` on the main service produces a warning (the entrypoint will
  fail without `AFK_GIT_URL` / `GITHUB_TOKEN`).

Sidecars share the Run's Docker daemon and network. `/workspace` is mounted into
the main service only; declare a named volume in the compose file if other
services need source access.

## 3. `afk.config.json` (required)

Declares the Backend, git URL, and per-Backend settings. See
[Configuration](/reference/configuration/) for the full schema.

## 4. `.afk.env` (gitignored)

Environment variables for Runs — plain strings or `secret:<name>` references. See
[Configuration](/reference/configuration/#afkenv-gitignored).
