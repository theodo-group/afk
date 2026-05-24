# Improvements

Backlog of known gaps in the v2 implementation, ordered by value.
Bugs found during live testing are folded in where relevant.

**Status legend:** ✅ shipped · ⏳ pending · ⏸ deferred

---

## 7. `afk team` commands untested ⏳

**Gap.** `afk team add|ls|rm` exist in the CLI surface but were never exercised end-to-end during the live deploy. Admin onboarding is unverified.

**Approach.** Run through `afk team add <username>` on a non-admin IAM principal, confirm the developer policy is attached, confirm RunInstances conditions hold. Add an integration test.

**Touches:** `cli/src/services/TeamService.ts` (probably no code change; just verification + docs).

---

## 11. CF attach via `wrangler containers ssh` — live verification ⏳

**Decision (2026-05).** The original WSS path proxied stdio through the launcher
Worker into `container.exec()`. That was abandoned: the SDK's `exec()` is
pipe-based (`ContainerExecOptions` has no `tty`, `ExecProcess` has no resize —
see `workers-types/experimental`), so it cannot host a real terminal. Attach now
shells out to Cloudflare's `wrangler containers ssh <instance-id>`, which
allocates a proper PTY. The launcher Worker only resolves runId → instance id
(Owner-scoped, `GET /runs/:id/ssh-target`); the SSH connection itself runs
CLI-side and needs local `CLOUDFLARE_API_TOKEN` + an `ssh-ed25519` key in the
deployed `worker/afk/wrangler.toml`.

**Live-verify gates (cannot be settled from docs — the public API reference
404s on the containers section, and nothing is deployed yet):**
  - `RunDO.resolveInstanceId()` — the CF REST paths (`/containers/applications`,
    `…/instances`) and *which* instance field carries the Container DO id used
    for correlation. Three lines are marked `// LIVE-VERIFY` in `runDO.ts`.
  - Whether `wrangler containers ssh <id> -- <cmd>` allocates a TTY for the
    trailing command (needed for the `--service`/default service-container path;
    `--host` gets the plain interactive shell regardless). Marked `// LIVE-VERIFY`
    in `CloudflareCompute.ts:attach`.

**Approach.** Deploy to a real CF account, add an ed25519 key + redeploy, run a
real `afk run` with sidecars, then exercise `afk attach <run-id>`,
`afk attach --service postgres <run-id>`, `afk attach --host <run-id>`. Resize
the terminal mid-session. Confirm the Owner check rejects another developer's
Run.

**Touches:** `cli/src/backends/cloudflare/CloudflareCompute.ts:attach`,
`worker/cloudflare/src/runDO.ts` (`handleSshTarget` / `resolveInstanceId`),
`worker/cloudflare/src/launcher.ts` (`/runs/:id/ssh-target`).

---

## 12. CF integration test against a real account ⏳

**Gap.** PRs 2-5 are "compiles, looks right." None of the CF Backend has been exercised against a real Cloudflare deployment. The four highest-risk paths — image build/push, `afk run` happy path, attach, history queries — all need at least one end-to-end run on a real account before we recommend CF to anyone outside this repo.

**Approach.** Provision a throwaway CF account, run the [Quickstart on Cloudflare](./README.md#quickstart-on-cloudflare) cold, capture what breaks, file follow-ups.

**Touches:** none anticipated in code; this is verification work that will surface the next batch of bugs.

---

## 15. CF live-test findings (first real-account deploy, 2026-05-23)

First end-to-end CF deploy against a real account (the verification work #12 anticipated). Remaining setup-gap findings listed for follow-up.

**15.8 `afk doctor` should precheck the Workers Paid / Containers entitlement ⏳.** CF Containers requires the Workers Paid plan; on a Free-plan account every container op fails with a bare `Unauthorized` (the real *"requires the Workers Paid plan"* message is buried in wrangler's log file). `afk doctor` (and `golden build`) should detect this early via `wrangler containers list` and surface the upgrade URL.

**15.16 CF execution — remaining follow-ups ⏳.** The CF execution path is now resolved end-to-end (`afk run` executes and is fully observable; logs + status arrive via the golden bootstrap's `POST /runs/:id/complete` callback). Remaining minor items:
- `afk logs --follow` can't stream a still-running container (logs are shipped at exit) — needs incremental log push.
- `POST /runs/:id/complete` should carry a per-run token rather than relying on runId unguessability.

**15.17 `afk logs` options must precede the positional run-id ⏳ (cosmetic).** `afk logs <id> --follow` errors with "Received unknown argument '--follow'"; `afk logs --follow <id>` works. An @effect/cli ordering quirk — surface a clearer error or allow interleaving.

---

## 13. Operability nits

- **Region as a Layer.** ⏳ Every adapter currently takes `region` as a parameter to every method. A `RegionContext` Layer set from `ConfigService.load` would clean ~50 call sites.
- **YAML parser for compose.** ⏳ See #6; would also let us inject `command: ${AFK_COMMAND}` and `env_file:` automatically instead of erroring.

---

## Deferred

Items the design supports but no implementation plan has been scheduled for.

### Local Backend (`--local`) ⏸

**Gap.** README originally promised it; current implementation has no `--local` paths. The design intent stands — same image, entrypoint, env, secrets, and lifecycle, just on the developer's local Docker daemon.

**Approach.** Implement a `LocalBackend` Compute layer that builds the wrapped image, resolves `secret:<name>` references via the active cloud Backend's `SecretStore`, runs `docker compose up --exit-code-from <main>` with labels for `afk ls --local` enumeration. `afk golden build --local` refuses with a clear message.

**Touches:** new `cli/src/backends/local/*.ts`, dispatch logic in `cli/src/cli.ts`.

---

## Out of scope (deliberate non-goals)

For reference, not improvements:

- Multi-region (one region per AFK-config).
- Cron / scheduled Runs.
- Notifications on Run completion (SNS / email / Slack).
- Artifact retrieval beyond logs (agents push their own results).
- GPU and bare-metal instance types.
- Warm-pool of pre-booted VMs.
- Single-binary distribution (Bun runtime required).

These are in `README.md`'s "Out of scope for v1" section and shouldn't drift into this backlog.
