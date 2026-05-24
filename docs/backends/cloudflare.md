# Cloudflare Backend

Each Run is one Cloudflare Container instance bound to a Durable Object inside a customer-deployed launcher Worker. The Container runs rootless `dockerd` to host the workload. The Compose Contract is honored under additional per-backend rules (rootless-only images, `network_mode: host`, no privileged).

See the [README quickstart](../../README.md#quickstart-on-cloudflare) for the setup commands. This document covers the topology, limitations, provisioning, and attach / lifecycle / cost specifics. See also [`worker/cloudflare/README.md`](../../worker/cloudflare/README.md) for the launcher Worker's internals.

## Topology and limitations

**Topology you're paying for.** Each Run gets its own Cloudflare Container instance (~a tiny VM you don't see), bound to a Durable Object inside the launcher Worker. The Container boots from the Golden Container image (rootless dind + pre-pulled sidecars), the dind spins up, and `docker compose up` runs the dev's `afk.compose.yml` inside it. On exit the Container stops; the Worker's DO records the row in D1 and unregisters from the in-memory index.

**Two auth boundaries.**

- **CLI → Worker** uses `Cf-Access-Client-Id` + `Cf-Access-Client-Secret` headers (CF Access service tokens). For single-dev mode the CLI also emits `Authorization: Bearer <AFK_SHARED_TOKEN>` when `AFK_SHARED_TOKEN` is set and no Access service token is configured (precedence: Access token → shared bearer → none). Production deploys should use Access service tokens.
- **Worker → CF API** uses the `CF_API_TOKEN` Worker secret (set during `afk provision`). Admin-scoped; never leaves the Worker.

**What `afk team add` does.** Calls the Worker's `/team` route, which uses `CF_API_TOKEN` to create a real CF Access service token and stores the `client_id → display_name` mapping in `DEVELOPERS_KV`. The `client_secret` is shown **once**; export it as `AFK_CF_CLIENT_SECRET` + `AFK_CF_CLIENT_ID` for subsequent CLI calls. Losing it means re-running `afk team add` under a new name.

**Cloudflare Access application setup.** For Access service tokens to actually gate the Worker, wrap the deployed Worker URL in a Cloudflare Access application (Zero Trust dashboard), allow service tokens, and add the ones from `afk team add` to its policy. Without this the Worker is publicly reachable and `authenticate()` falls back to the shared-bearer path (or rejects every request if `AFK_SHARED_TOKEN` isn't set).

**Compose rules the CLI auto-injects.** Every service in your `afk.compose.yml` gets `network_mode: host` plus `extra_hosts:` entries cross-mapping every sibling service name to `127.0.0.1`. Inter-service DNS keeps working (`postgres:5432` → `127.0.0.1:5432`) but two sidecars cannot bind the same port — a hard error at submit time.

**Logs.** Workers Logs only — **3 days retention on Workers Free, 7 days on Workers Paid**. No AFK-managed R2 mirror; for >7d use Cloudflare Logpush. `afk logs <run-id>` reads the per-Run logs the container ships to the Worker on exit (`GET /runs/:id/logs`); `--follow` polls until they appear.

**Maturity caveats.** Two behaviours to know before a first deploy: the per-Run _wrapper_ image cache check is stubbed (the wrapper image always rebuilds), and WSS `afk attach` is written but not yet exercised against a live deployment (it may need SIGWINCH / header tweaks). Current status of both lives in [`IMPROVEMENTS.md`](../../IMPROVEMENTS.md), not here.

## What `wrangler deploy` provisions

Run `afk provision` (or `wrangler deploy` from `worker/afk/`) once per account.

### The launcher Worker

- An HTTP/WSS Worker fronting every AFK operation: `/runs`, `/runs/:id`, `/runs/:id/attach` (WSS), `/secrets`, `/team`, `/health`. No direct CLI→CF-control-plane traffic for normal commands.
- Authenticates each request via the CF Access service-token client-id, or a shared bearer fallback for single-dev mode.

### Durable Objects

- **`RunDO`** — one per Run. Owns the Container instance, captures stdout/stderr for Workers Logs, and sets an alarm at `startedAt + timeoutHours + 30 min` as a backstop.
- **`RegistryDO`** — singleton index DO backing `afk ls`.
- Migrations are declared in `wrangler.toml` and applied on `wrangler deploy`.

### The Container binding

- `RunContainer` — the Container class the Worker dispatches Runs to. Each per-Run `RunDO` owns one instance, booted from the Golden Container image in `afk.config.json`.

### D1 + KV + R2

- **D1** (`afk-launcher-history`) — historical rows for `afk history`. Schema in `worker/cloudflare/migrations/0001_runs.sql`.
- **KV** (`DEVELOPERS_KV`) — Access service-token client-ids → display names. Written by `afk team add`.
- **R2** (`afk-launcher-session-artifacts`, binding `ARTIFACTS`) — per-Run Session Artifacts, created by `afk provision` before deploy.

## Session Artifacts

If `sessionArtifacts` is declared in `afk.config.json`, the golden bootstrap `docker cp`s the declared base dirs out of the main service at graceful exit, drops files over the ~25 MB cap (skip, never truncate), tars + gzips the staged tree, and POSTs it base64-encoded to `POST /runs/:id/session-artifact` (per-Run-token auth, like the log callbacks — the Container has no CF Access creds). The RunDO stores the tarball in R2 keyed `<repo>/<runId>/session-artifacts.tar.gz`. `afk session-artifact <run-id>` GETs `/runs/:id/session-artifact` (CF-Access-authed, Owner-scoped CLI-side), base64-decodes and extracts the tarball, applies the precise globs + cap, and writes the survivors to `--out`. Best-effort: a killed or hard-timed-out Run never reaches the upload. R2's lifecycle window is the dev's to set; teardown deletes the bucket if it is empty (otherwise `afk destroy` reports it for manual removal).

### Not created by `wrangler deploy`

- **The Golden Container image** — built by `afk golden build`, pushed to the CF managed registry.
- **Workers Secrets** — `CF_API_TOKEN` via `wrangler secret put`; per-Run secrets via the Worker's `/secrets` route.

## Secrets

Stored as **Workers Secrets** on the launcher Worker, written via `/secrets` (called by `afk secrets put`). At Run start the Worker materialises them into the Container's environment. Values never appear in D1, KV, or Workers Logs.

## Attach

SSM has no equivalent, and the SDK's `container.exec()` is pipe-based (no PTY), so attach shells out to `wrangler containers ssh <instance-id>`, which allocates a PTY. The CLI first calls the Worker's `GET /runs/:id/ssh-target` (Owner-scoped — the Worker uses `CF_API_TOKEN` to resolve the instance id), then runs `wrangler containers ssh` against it. `--host` lands on the outer Container's host shell; default/`--service <name>` appends `-- docker compose exec <service>` (falling back to `docker exec`).

- **Account auth at attach time.** `wrangler containers ssh` needs `CLOUDFLARE_API_TOKEN` exported locally (the per-developer Access token is not sufficient). The only CF command that bypasses the launcher Worker.
- **One-time key setup.** Requires an `ssh-ed25519` public key under `[[containers.authorized_keys]]` in `worker/afk/wrangler.toml`, applied at `wrangler deploy`. `afk doctor` reports whether a key is configured.

## Run lifecycle

The Run lives inside a Cloudflare Container instance owned by a per-Run DO. When the main process exits, CF terminates the Container automatically (the DO observes the exit, writes the final D1 row, cleans up). The timeout backstop is the DO's alarm (`startedAt + timeoutHours + 30 min`); the in-container `timeout(1)` is the primary mechanism.

## Run state and querying

- `afk ls` → the Worker reads the singleton `RegistryDO` for alive Runs.
- `afk history` → the D1 `afk-launcher-history` table.

## Costs

- Workers Paid plan ($5/mo) is required — Containers, Durable Objects, and Workers Logs (7-day retention) all need it.
- Worker invocations, DO requests, D1 reads/writes, KV reads: bundled into the Paid plan's quotas at this scale.
- Per-Run: Containers billed per Container-second at the chosen tier. No Spot equivalent. No baseline NAT/IGW cost. Cold start sub-5s (claim, not yet verified against a real deployment).

## Teardown

```sh
afk destroy            # dry-run
afk destroy --yes      # golden images, launcher Worker + DOs, the Container app
                       # (+ live instances), D1, KV, and the R2 artifacts bucket (if empty)
# Access service tokens (if any) are not deleted — remove via the Zero Trust dashboard.
# A non-empty R2 bucket is left in place — empty it, then `wrangler r2 bucket delete afk-launcher-session-artifacts`.
```
