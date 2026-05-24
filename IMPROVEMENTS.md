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

## 9. CF Container registry listing — wrapper path ⏳

**Gap.** `CloudflareImageRegistry.imageExists` and `listLatestTagsByPrefix` (the per-Run *wrapper* image cache lookups) remain stubbed — so `afk build`/`afk run` always rebuild+push the wrapper rather than skipping on a cache hit. The golden path was resolved during the 2026-05-23 live test by shelling out to `wrangler containers images list`; the same approach applies here, just not wired into the wrapper path yet.

**Touches:** the `imageExists`/`listLatestTagsByPrefix` call sites in the wrapper build path.

---

## 10. CF Workers Logs GraphQL Analytics query ⏳

**Gap.** `CloudflareLogStore.read{,Stream}` currently shells out to `wrangler tail` for both follow and non-follow modes. `wrangler tail` is right for live tailing but is the wrong tool for historical reads over a window (`--since 30d` style queries) — it streams from "now" and exits when there are no more events.

**Approach.** Use the Cloudflare GraphQL Analytics endpoint for non-follow reads (`https://api.cloudflare.com/client/v4/graphql`, dataset `workersInvocationsAdaptive` or `cloudflareLogs` — needs verification). Keep `wrangler tail` for `--follow`.

**Touches:** `cli/src/backends/cloudflare/CloudflareLogStore.ts`.

---

## 11. CF WSS attach end-to-end verification ⏳

**Gap.** The WSS attach path (CLI → launcher Worker `/runs/:id/attach` → DO → `docker compose exec` inside the outer Container) is written but never tested against a real Container. Specifically unverified: SIGWINCH forwarding for terminal resize, `Cf-Access-Client-Id` header propagation on the WS upgrade, Bun's WS client's `headers` option behavior at upgrade time.

**Approach.** Deploy to a real CF account, run a real `afk run` with sidecars, exercise `afk attach <run-id>` and `afk attach --service postgres <run-id>` and `afk attach --host <run-id>`. Resize the terminal mid-session. Validate audit log entries.

**Touches:** `cli/src/backends/cloudflare/CloudflareCompute.ts:attach`, `worker/cloudflare/src/runDO.ts:attachHandler`.

---

## 12b. CF single-dev shared bearer (`AFK_SHARED_TOKEN`) ⏳

**Gap.** The launcher Worker's `authenticate()` accepts `Authorization: Bearer <AFK_SHARED_TOKEN>` as a single-developer escape hatch (`worker/cloudflare/src/auth.ts`). The CLI's `CloudflareCompute` / `CloudflareSecretStore` / `CloudflareRunHistory` only emit `Cf-Access-Client-Id` + `Cf-Access-Client-Secret` headers — the bearer path is never reachable from the CLI today.

**Approach.** When `AFK_SHARED_TOKEN` is set in the dev's env and `AFK_CF_CLIENT_ID` is absent, every Cloudflare HTTP call should send `Authorization: Bearer <value>` instead. ~5 lines per file (add a small `cfAuthHeaders()` helper in `cli/src/backends/cloudflare/`). README's "Cloudflare auth model" already cites this gap.

**Touches:** `cli/src/backends/cloudflare/*.ts` (headers helper + call-site updates).

---

## 12. CF integration test against a real account ⏳

**Gap.** PRs 2-5 are "compiles, looks right." None of the CF Backend has been exercised against a real Cloudflare deployment. The four highest-risk paths — image build/push, `afk run` happy path, attach, history queries — all need at least one end-to-end run on a real account before we recommend CF to anyone outside this repo.

**Approach.** Provision a throwaway CF account, run the [Quickstart on Cloudflare](./README.md#quickstart-on-cloudflare) cold, capture what breaks, file follow-ups.

**Touches:** none anticipated in code; this is verification work that will surface the next batch of bugs.

---

## 15. CF live-test findings (first real-account deploy, 2026-05-23)

First end-to-end CF deploy against a real account (the verification work #12 anticipated). Remaining setup-gap findings listed for follow-up.

**15.6 README's required-token-scopes list is incomplete ⏳.** The quickstart lists `Workers Scripts / KV / D1 / Containers / Access` (all Edit). Live testing showed the registry push also needs **Cloudflare Images: Edit** (and **Workers Containers: Edit**), and `afk team add` needs **Access: Service Tokens: Edit**. Update the README prerequisites and the `ensureRepoAndAuth` error string (it still says "Containers Edit" only). (`afk init`'s missing-token error now lists `Cloudflare Images:Edit`; the README prerequisites list still needs the same addition.)

**15.7 `afk team add` requires Zero Trust Access to be enabled first ⏳.** Even with correct token scopes + `CF_ACCOUNT_ID`, `POST /access/service_tokens` returns `access.api.error.not_enabled` until the account has enabled Cloudflare Access (a one-time Zero Trust dashboard action — pick a team domain). The quickstart's step 6 assumes an Access app but never says "first enable Access." Document it, and surface the `not_enabled` error from `afk team add` with a dashboard hint instead of a raw API blob.

**15.8 `afk doctor` should precheck the Workers Paid / Containers entitlement ⏳.** CF Containers requires the Workers Paid plan; on a Free-plan account every container op fails with a bare `Unauthorized` (the real *"requires the Workers Paid plan"* message is buried in wrangler's log file). `afk doctor` (and `golden build`) should detect this early via `wrangler containers list` and surface the upgrade URL.

**15.16 CF execution — remaining follow-ups ⏳.** The CF execution path is now resolved end-to-end (`afk run` executes and is fully observable; logs + status arrive via the golden bootstrap's `POST /runs/:id/complete` callback). Remaining minor items:
- `afk logs --follow` can't stream a still-running container (logs are shipped at exit) — needs incremental log push.
- `POST /runs/:id/complete` should carry a per-run token rather than relying on runId unguessability.

**15.17 `afk logs` options must precede the positional run-id ⏳ (cosmetic).** `afk logs <id> --follow` errors with "Received unknown argument '--follow'"; `afk logs --follow <id>` works. An @effect/cli ordering quirk — surface a clearer error or allow interleaving.

**15.12 `afk secrets ls` shows an AWS "SSM PATH" column on CF ⏳ (cosmetic).** The table header is hardcoded for the AWS/SSM backend; on Cloudflare it prints `AFK_SECRET_<name>` under "SSM PATH". Harmless but misleading — the column should be backend-neutral (or omitted on CF).

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
