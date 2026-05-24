# AFK launcher Worker (Cloudflare)

The Cloudflare Backend's gateway. Deployed once per AFK install into the consumer's Cloudflare account, it exposes the HTTP/WSS surface the AFK CLI's `CloudflareCompute` layer talks to.

This directory is **vendored** in the claudebox repo; `afk init --provider cloudflare` copies it to the consumer's `worker/afk/` (parallel to how the AWS Backend ships `terraform/aws/` → `terraform/afk/`).

## Components

| File | Purpose |
| --- | --- |
| `src/launcher.ts` | Hono HTTP router. Auth, routing, D1 history writes, CF API proxying. |
| `src/runDO.ts` | Per-Run Durable Object. Owns one `RunContainer`. Sets the timeout-backstop alarm. Captures stdout/stderr for Workers Logs. |
| `src/registryDO.ts` | Singleton index DO. Backs `afk ls` without fanning out to every per-Run DO. |
| `src/auth.ts` | Validates Cloudflare Access service tokens (or shared bearer fallback for single-dev mode). |
| `src/types.ts` | Shared types between launcher, DOs, and the CLI's CF Backend layer. |
| `wrangler.toml.template` | Rendered by the CLI at `afk init` time. |
| `migrations/0001_runs.sql` | D1 schema. Run by the CLI during init. |

## Topology

```
afk CLI
  │
  │  HTTPS  /runs, /history, /secrets, /team
  │  WSS    /runs/:id/attach
  ▼
Launcher Worker (this directory)
  ├── Hono router (auth → routing → handlers)
  ├── DO bindings:  RunDO (per-Run)   RegistryDO (singleton index)
  ├── D1 binding:   DB                (history table)
  ├── KV binding:   DEVELOPERS_KV     (client-id → name)
  ├── R2 binding:   ARTIFACTS         (per-Run Session Artifact tarballs)
  └── Container binding: RunContainer (the boot artifact = wrapped agent image)
      │
      ▼ each per-Run DO owns one Container instance
      Container (rootless dind + dev's wrapped agent image)
        └── docker compose up (the dev's afk.compose.yml, auto-network_mode-host'd)
```

## Auth modes

- **Production: Cloudflare Access service tokens.** Each developer gets one, provisioned by `afk team add <name>`. The Worker reads `Cf-Access-Client-Id` and uses it as the Owner.

- **Single-dev: `AFK_SHARED_TOKEN` Worker secret.** Set during `afk init` for individuals who don't want to set up Access. Owner is hardcoded to `local`.

## Logs

Container `stdout` / `stderr` flow into Workers Logs automatically (because `observability.enabled = true` in `wrangler.toml`). The CLI queries Workers Logs (3-day Free / 7-day Paid retention) for both historical reads and live tailing via Tail Workers. No R2 mirror of *logs* in v1 (the `ARTIFACTS` R2 bucket holds Session Artifacts only, not a log mirror).

## Timeout enforcement

The DO sets an alarm at `startedAt + timeoutHours + 30 min` grace. When the alarm fires, the DO checks the Container's state and stops it if still alive. The agent's `timeout(1)` inside the container is still the primary mechanism — the alarm is the backstop.

## Deploy

After `afk init --provider cloudflare`, the consumer runs:

```sh
cd worker/afk
wrangler d1 create afk-launcher-<repo>-history     # one-time
wrangler kv:namespace create developers             # one-time
# Fill in the two IDs into wrangler.toml's d1_databases + kv_namespaces.
wrangler deploy
wrangler secret put CF_API_TOKEN                    # admin-scoped token
wrangler secret put CF_ACCOUNT_ID
```

The CLI's `afk init` automates these once the consumer has `wrangler` on PATH and `CLOUDFLARE_API_TOKEN` exported.

## Local dev

```sh
npm install
npm run typecheck
npm run dev   # wrangler dev — local emulator
```

Note: DO + Container bindings don't all run locally; `wrangler dev --remote` is the closest to the real deployment.
