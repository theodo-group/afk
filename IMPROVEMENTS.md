# Improvements

Backlog of known gaps in the v2 implementation, ordered by value.
Bugs found during live testing are folded in where relevant.

**Status legend:** ✅ shipped · ⏳ pending · ⏸ deferred

---

## Cloudflare Backend ✅ (PRs 1-5 of the v2 split, landed)

**Shipped.** AFK now supports two cloud Backends: AWS EC2 (original) and Cloudflare Containers (new). Selection is per-project via `afk init --provider <aws|cloudflare>` and persisted in `afk.config.json`.

Landed across five PRs at commits:
- `93d0d5e` — PR 1: extract `Backend` interface as Effect service tags (refactor, AWS-only).
- `fbc8e53` — PR 2: scaffold Cloudflare launcher Worker (`worker/cloudflare/`).
- `98ab4f3` — PR 3: Cloudflare Backend in the CLI.
- `92f7e5c` — PR 4: Cloudflare Golden Image pipeline.
- PR 5: docs polish + `afk doctor` CF dispatch (this commit).

Open follow-ups for the CF Backend are listed below as their own entries.

---

## 1. Run history (persistent post-mortem) ✅

**Gap.** `afk ls` only sees what's in `ec2:DescribeInstances`, which retains terminated instances for ~1 hour. After that, the VM is gone — CloudWatch Logs survives 30 days but there's no way to enumerate "all my Runs this week" with owner / branch / sha / exit code without remembering each run-id.

**Approach: DynamoDB-backed run table.**
- Terraform adds an `afk-runs` table (on-demand billing, partition key = `run_id`, GSIs on `owner` and `started_at`).
- `RunService.start` writes a row at `ec2:RunInstances` time.
- Sweeper Lambda extended to update `status` + `exit_code` + `stopped_at` when an instance is terminated.
- New `afk history [--since 7d] [--branch …] [--owner …]` command queries the table.
- Existing `afk ls` keeps its EC2-truth semantics; history is a separate read path.

**Why this and not the alternatives.**
- CloudWatch stream enumeration is $0 but loses owner/branch/sha — those would need to be stuffed into stream names, which is ugly.
- S3 manifest objects work but require a list-and-fetch dance to read; queries on owner/branch get awkward without an index.

**Touches:** new `cli/src/services/HistoryService.ts`, new `cli/src/adapters/aws/DynamoDb.ts`, additions to `RunService` + sweeper Lambda + Terraform.

---

## 2. `afk run` doesn't stream logs without `--detach` ✅

**Gap.** README documents `--detach / -d` as the flag to skip log streaming; the implication is the default streams logs. The streaming code path doesn't exist — `afk run` always exits after launch.

**Approach.** When `--detach` is absent, wait for the VM to reach `running`, then exec `afk logs <run-id> --follow` in-process until the instance terminates. Honor `Ctrl-C` cleanly (detach, leave Run going).

**Touches:** `cli/src/commands/run.ts`, `cli/src/services/RunService.ts` (small helper that polls instance state).

---

## 3. `afk attach` refuses on non-RUNNING Runs ✅

**Gap.** Today: `attach` errors with "Run is not RUNNING (status: STOPPED)." But for ~1 hour after termination the VM still exists in `DescribeInstances`, and SSM Session Manager can still reach a stopped-but-not-yet-terminated host. Useful for post-mortem.

**Approach.** Allow `attach` against `STOPPING` / `STOPPED` if EC2 still reports an instance with a reachable status. Refuse only when the instance is genuinely gone.

**Touches:** `cli/src/services/RunService.ts:attach`.

---

## 4. Docker build cache shared across Runs ✅

**Gap.** Every `afk run` on a new git sha rebuilds the wrapper image; the user's `afk.Dockerfile` layers get redone because no BuildKit cache is shared between invocations. Most rebuilds are no-ops layer-wise but currently take 10-30s of useless docker work.

**Approach.** Mount a project-local BuildKit cache dir into `docker build` via `--cache-from type=local,src=...` + `--cache-to`. Optionally, push wrapper layers separately so `docker pull` on the VM short-circuits known layers. The `--cache-from` flag against the previous ECR tag is the cheapest win.

**Touches:** `cli/src/adapters/Docker.ts`, `cli/src/services/BuildService.ts`.

---

## 5. `afk run --dry-run` ✅

**Gap.** No way to preview what a Run would do without launching it.

**Approach.** New flag emits: resolved instance type, AMI ID, subnet, security group, spot price quote, env names (no values), compose-file render, generated user_data (truncated). Exit 0 without calling `ec2:RunInstances`.

**Touches:** `cli/src/commands/run.ts`, `cli/src/services/RunService.ts` (extract launch into "plan" + "execute" phases).

---

## 6. Compose `command:` override silently wins ✅

**Gap.** If the dev hardcodes `command: ...` on the main service instead of using `${AFK_COMMAND}`, their `afk run <args>` invocation is silently ignored — the static compose command runs. Today the lint emits a warning, not an error.

**Approach (two choices):**
- **Easy:** promote the missing-`${AFK_COMMAND}` lint to an error.
- **Better:** YAML-parse the compose file on the CLI side and inject `command: ${AFK_COMMAND}` on the main service automatically. Requires adding a YAML dep (`yaml` package).

**Touches:** `cli/src/services/Compose.ts`.

---

## 7. `afk team` commands untested ⏳

**Gap.** `afk team add|ls|rm` exist in the CLI surface but were never exercised end-to-end during the live deploy. Admin onboarding is unverified.

**Approach.** Run through `afk team add <username>` on a non-admin IAM principal, confirm the developer policy is attached, confirm RunInstances conditions hold. Add an integration test.

**Touches:** `cli/src/services/TeamService.ts` (probably no code change; just verification + docs).

---

## 8. Per-Run cost reporting ✅ (estimate only — hardcoded price table)

**Gap.** `afk ls` shows duration but not cost. Trivially derivable from instance-type + spot-price-at-launch + EBS-hours + CloudWatch ingest. Worth surfacing.

**Approach.** Cache spot price at launch in a new tag `afk:spot-price`. New column in `afk ls` (and field in history rows from #1): `cost ≈ $X.XX`. `afk cost <since>` rollup command for totals.

**Touches:** `cli/src/services/RunService.ts:start` (capture spot price), `cli/src/commands/ls.ts`, new `cli/src/commands/cost.ts`.

---

## 9. CF Container registry listing ✅ (golden path) / ⏳ (wrapper path)

**Gap.** `CloudflareImageRegistry.imageExists` and `listLatestTagsByPrefix`, and `CloudflareGoldenBuilder.list`/`findLatest`, were stubbed to `false` / `[]` / `null` pending the CF Container Distribution v2 API auth flow being nailed down. Without these, `afk run` on CF cannot resolve the wrapper image or the Golden image, so the path was blocked even after a successful `afk golden build`.

**Resolution (golden path, shipped during live test 2026-05-23).** Rather than the raw Distribution v2 handshake, the registry ops now shell out to `wrangler containers ...`, which performs the CF managed-registry credential exchange internally:
- `CloudflareImageRegistry.push` → `wrangler containers push <tag>` (the previous raw-API-token `docker login` to `registry.cloudflare.com` always 401'd — see entry 15.1).
- `CloudflareGoldenBuilder.list` / `findLatest` → parse `wrangler containers images list --json` (slicing the JSON array out of wrangler's stdout banners).
- `CloudflareGoldenBuilder.remove` → `wrangler containers images delete <repo>:<tag>`.
This unblocks `afk doctor`'s golden check and `CloudflareCompute.prepare`'s golden presence check.

**Still ⏳.** `imageExists` / `listLatestTagsByPrefix` (the per-Run *wrapper* image cache lookups) remain stubbed — so `afk build`/`afk run` always rebuild+push the wrapper rather than skipping on a cache hit. Same `wrangler containers images list` approach applies; just not wired into the wrapper path yet.

**Touches (done):** `cli/src/backends/cloudflare/CloudflareImageRegistry.ts`, `cli/src/services/CloudflareGoldenBuilder.ts`. **Remaining:** the `imageExists`/`listLatestTagsByPrefix` call sites in the wrapper build path.

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

## 14. `afk init` should run the provisioner (Terraform / Wrangler) automatically ✅ (both backends)

**Update (shipped 2026-05-23).** A single `afk provision` command now provisions either backend, and `.env` is auto-loaded so no command needs manual sourcing.

- **AWS:** `afk provision` runs `terraform init && terraform apply` against the `terraform/afk` module (region from `afk.config.json`), so the developer never leaves the CLI. (`afk init --provider aws` now points at it.)
- **Cloudflare:** the 3-command flow below with zero manual file edits:
- `afk init --provider cloudflare` derives the account id from `CLOUDFLARE_API_TOKEN` (`GET /accounts`), merges a `cloudflare:` block into any existing config (flipping `backend`, preserving the `aws:` block — closes 15.9), and renders `wrangler.toml` with the real `account_id` + `CF_ACCOUNT_ID`.
- `afk golden build` auto-patches its pushed image URI into `worker/afk/wrangler.toml`.
- `afk provision` (new) runs `npm install`, creates the D1 DB + KV namespace (idempotent — reuses existing), patches their ids into `wrangler.toml`, applies the migration, `wrangler deploy`s, patches `workerUrl` into `afk.config.json`, and sets the `CF_API_TOKEN` secret.

**Touches (done):** `cli/src/commands/provision.ts` (both backends), `cli/src/adapters/Terraform.ts` (new `apply`), `cli/src/infra/CfToml.ts`, `cli/src/commands/golden/build.ts`, `cli/src/services/BootstrapService.ts` (CF init merge + AWS/CF next-steps), `cli/src/cli.ts` (+ dotenv auto-load so no command needs `.env` sourcing).

---

## 14b. (original AWS-side note retained)

**Gap.** `afk init` only scaffolds files and (on AWS) creates the S3 state bucket. The actual infra provisioning is left to the developer as a manual follow-up, and the two Backends are asymmetric in how much work that is:

- **AWS:** init creates the state bucket + copies the Terraform module + renders `backend.tf`, then prints `cd terraform/afk && terraform init && terraform apply`. One declarative command, but the user still runs it by hand.
- **Cloudflare:** init creates *nothing* in the cloud — it only copies `worker/afk/` and the `wrangler.toml` template. The developer then runs ~5 imperative `wrangler` commands by hand (`d1 create`, `kv:namespace create`, `d1 execute` migration, `deploy`, `secret put`) **and** manually copies the returned `database_id` / namespace `id` back into `wrangler.toml`. There is no `terraform apply` equivalent — no single-shot provisioner.

Found while testing the CF flow live in a consumer repo: the manual ID-copy round-trips are the most error-prone part of CF onboarding, and the asymmetry vs. AWS is jarring.

**Approach.**
- **AWS:** add an opt-in `afk init --apply` (or a separate `afk provision`) that shells out to `terraform init && terraform apply` after scaffolding, surfacing the plan for confirmation.
- **Cloudflare:** add the missing provisioner. Either init (with `--apply`) or a new `afk provision` runs `wrangler d1 create` + `kv:namespace create`, captures the returned IDs, patches them into `wrangler.toml` automatically, runs the migration, and optionally `wrangler deploy`. This is the CF analog of `terraform apply` and removes the hand-copy of IDs entirely.
- Keep the pure-scaffold behavior as the default (no surprise cloud mutations); gate provisioning behind an explicit flag/subcommand so init stays idempotent and offline by default.

**Touches:** `cli/src/services/BootstrapService.ts` (`initAws` / the CF init path), `cli/src/adapters/Terraform.ts`, a new Wrangler adapter (`cli/src/adapters/Wrangler.ts` or similar) for the CF resource-creation calls, `cli/src/commands/init.ts` (new flag) or a new `cli/src/commands/provision.ts`.

---

## 15. CF live-test findings (first real-account deploy, 2026-05-23)

First end-to-end CF deploy against a real account (the verification work #12 anticipated). Got cleanly through `afk init` → `golden build` → `wrangler deploy` → `afk doctor` (all green). Bugs found and fixed inline; remaining setup-gap findings listed for follow-up.

**15.1 Registry `docker login` could never authenticate ✅ (fixed).** `CloudflareImageRegistry.ensureRepoAndAuth` did `docker login registry.cloudflare.com/<acct> -u cloudflare -p $CLOUDFLARE_API_TOKEN`. The CF managed registry rejects the raw API token (401 every time). Replaced with `wrangler containers push` (see #9). `ensureRepoAndAuth` is now a token-presence check only.

**15.2 Golden registry listing stubbed ✅ (fixed).** See #9 — `list`/`findLatest`/`remove` implemented via `wrangler containers images`.

**15.3 `RunContainer` not declared as a DO class ✅ (fixed in template).** `wrangler.toml.template` referenced `class_name = "RunContainer"` in `[[containers]]` but never declared it as a Durable Object. `wrangler deploy` failed: *"the container class_name RunContainer does not match any durable object class_name."* Added a `RUN_CONTAINER` DO binding and `RunContainer` to `new_sqlite_classes`.

**15.4 `runDO.ts` missing `DurableObject` import ✅ (fixed in template).** `RunDO extends DurableObject<Env>` but the file never imported `DurableObject`. Deploy failed at validation with *"DurableObject is not defined."* `registryDO.ts` imported it correctly; `runDO.ts` didn't. Added `import { DurableObject } from "cloudflare:workers"`.

**15.5 `CF_ACCOUNT_ID` never provided to the Worker ✅ (fixed in template).** The `/team` and `/secrets` routes read `c.env.CF_ACCOUNT_ID`, but the template defined no `[vars]` block, so it was undefined → *"Worker missing API token"* (500). Added `[vars] CF_ACCOUNT_ID = "{{account_id}}"`.

**15.6 README's required-token-scopes list is incomplete ⏳.** The quickstart lists `Workers Scripts / KV / D1 / Containers / Access` (all Edit). Live testing showed the registry push also needs **Cloudflare Images: Edit** (and **Workers Containers: Edit**), and `afk team add` needs **Access: Service Tokens: Edit**. Update the README prerequisites and the `ensureRepoAndAuth` error string (it still says "Containers Edit" only).

**15.7 `afk team add` requires Zero Trust Access to be enabled first ⏳.** Even with correct token scopes + `CF_ACCOUNT_ID`, `POST /access/service_tokens` returns `access.api.error.not_enabled` until the account has enabled Cloudflare Access (a one-time Zero Trust dashboard action — pick a team domain). The quickstart's step 6 assumes an Access app but never says "first enable Access." Document it, and surface the `not_enabled` error from `afk team add` with a dashboard hint instead of a raw API blob.

**15.8 `afk doctor` should precheck the Workers Paid / Containers entitlement ⏳.** CF Containers requires the Workers Paid plan; on a Free-plan account every container op fails with a bare `Unauthorized` (the real *"requires the Workers Paid plan"* message is buried in wrangler's log file). `afk doctor` (and `golden build`) should detect this early via `wrangler containers list` and surface the upgrade URL.

**15.9 init does not scaffold a `cloudflare:` block into an existing config ✅ (fixed).** `afk init --provider cloudflare` now merges a `cloudflare:` block into an existing config and flips `backend`, preserving the `aws:` block. See #14.

**15.13 `RunDO.getContainer()` addressed the wrong binding ✅ (fixed).** First live `afk run` on CF returned 500. The Worker threw `TypeError: The RPC receiver does not implement the method "start"` because `getContainer()` did `env.RUN_DO.get(...)` (another RunDO) and called Container methods on it. Fixed to address `env.RUN_CONTAINER` (the Container class), added `RUN_CONTAINER` to the `Env` type. After the fix, `afk run` launches and the Run appears in `afk ls` as PROVISIONING. Touches `worker/cloudflare/src/runDO.ts`, `types.ts`.

**15.14 `afk logs` ignored the active backend ✅ (fixed).** On CF, `afk logs <id>` called the **AWS** CloudWatch adapter (`FilterLogEvents`) and failed with `ResourceNotFoundException`. Two fixes: (1) `cli/src/commands/logs.ts` now dispatches through the backend `LogStore` service instead of importing the AWS `Logs` adapter directly (so AWS → CloudWatch, CF → `wrangler tail`); (2) `CloudflareLogStore` no longer passes `--since` to `wrangler tail` (which has no such flag — it always errored). `afk logs --follow <id>` now tails Workers Logs live.

**15.15 CF Run status stuck at PROVISIONING ✅ (fixed).** Root cause was an ordering race, not missing wiring: the launcher's `/runs` added the RegistryDO row (`PROVISIONING`) *after* `await stub.fetch(/start)` returned — but `handleStart` already ran `markRunning()` → `updateRegistry(RUNNING)` against a row that didn't exist yet (404, dropped), so the later add left it at PROVISIONING. Fixed by having `RunDO.handleStart` register itself (`addToRegistry`, PROVISIONING) *before* `container.start()`, and removing the launcher's late add. Verified: a Run now shows RUNNING in `afk ls`.

**15.16 CF Run never executes the workload ⏳⏳ (major — the CF execution path is unimplemented).** Investigated live: `afk run` launches, the Run shows RUNNING, but the agent command never runs and no output appears. Three interlocking root causes:

1. **No workload orchestration.** The CF Container boots the **golden** image, whose entrypoint starts `dockerd` then `exec`s `CMD = tail -f /dev/null` — it idles. The per-Run **wrapper** image is built `FROM <user image>` (BuildService `Dockerfile.wrapper`), *not* `FROM afk-golden` (despite the comment in `CloudflareCompute.ts:164`), and nothing ever pulls/runs it inside the container. There is no CF analog of the AWS `user_data` that does `docker run`/`docker compose up` of the wrapper. The CLI sends `command: []` (see `CloudflareCompute.ts:275`) and assumes "the container's own ENTRYPOINT" runs the workload — but golden's entrypoint just idles. **This is the core gap**: the golden bootstrap (or RunDO, post-start) must run the wrapper image + command + compose from the injected env (`AFK_IMAGE`, `AFK_COMMAND`/command, `AFK_ENV_FILE`, compose), capture the exit code, and exit so the container stops. Likely needs in-container auth to pull `AFK_IMAGE` from `registry.cloudflare.com`.
2. **Container instance failing.** `RunContainer` logs `Container error: Error: Network connection lost` — the rootless-dind golden container isn't staying up/reachable. Whether rootless `dockerd` runs at all on CF Containers (capabilities/`--privileged` constraints) is unverified and may force a different approach (e.g. run the agent image directly as the Container for the no-sidecar case).
3. **Container stdout not in `wrangler tail`.** Even golden's own `echo "afk-golden: ..."` never appears in `wrangler tail` — it captures Worker/DO logs, not container *process* stdout. `afk logs` (built on `wrangler tail`) therefore structurally cannot surface workload output; container logs need the Containers observability/logs API instead.

Net: making `afk run` actually execute on CF is a real implementation effort with live unknowns (does rootless dind work on CF? in-container registry auth? container-log retrieval?), not a small fix. Subsumes the execution half of #11/#12.

**Update — orchestration implemented, container runtime is the blocker (2026-05-23).** The workload-orchestration half (root cause #1) is now built:
- Golden `bootstrap.sh` (CloudflareGoldenBuilder) now, after `dockerd` is up: `docker login` (with an injected pull credential) → `docker pull $AFK_IMAGE` → `docker run --env-file … $AFK_IMAGE sh -c "$AFK_COMMAND"` (or `docker compose up` with the injected compose), captures the exit code, and exits.
- `RunDO.handleStart` mints a short-lived registry **pull** credential via `POST …/containers/registries/registry.cloudflare.com/credentials`, base64-encodes the workload env file, and passes `AFK_IMAGE`/`AFK_COMMAND`/`AFK_MAIN_SERVICE`/`AFK_RUN_ENV_B64`/`AFK_REGISTRY_*`/`AFK_COMPOSE_YML` as the Container's control env.
- The CLI now actually sends the command (`PreparedRun.command`; `CloudflareCompute` was sending `command: []`).

**Remaining blocker (root causes #2/#3 — infra, unresolved):** even with the above, the Container instance crashes (`Container error: Network connection lost`), accumulating retry instances. The failure reason is invisible because container *process* stdout isn't in `wrangler tail` (it shows DO/Worker logs only). `wrangler containers info` shows the app runs with `network.mode = "private"` and **no** `assign_ipv4`/`assign_ipv6` — a candidate cause both for the crash and for an in-container `docker pull` being unable to reach `registry.cloudflare.com`. Open questions to resolve next, in order:
1. Does rootless `dockerd` even run inside a CF Container? (Verify via `wrangler containers ssh` into a minimal non-dind golden, or a hand-run instance.)
2. How to read container-instance stdout/logs (Containers observability API / dashboard) — needed to debug everything else.
3. Container egress under `mode: private` (can it pull from the managed registry / clone GitHub?).
Until #1–#3 are answered, `afk run` launches and tracks state correctly but the workload does not execute.

**15.17 `afk logs` options must precede the positional run-id ⏳ (cosmetic).** `afk logs <id> --follow` errors with "Received unknown argument '--follow'"; `afk logs --follow <id>` works. An @effect/cli ordering quirk — surface a clearer error or allow interleaving.

**15.11 `/secrets` route addressed an empty script name ✅ (fixed).** `afk secrets put/rm` on CF failed with CF API code 10001 ("Content-Type must be one of: application/javascript, …"). Cause: `getScriptName()` read `globalThis.WORKER_NAME` (always `undefined` — Worker vars live on `env`, not globalThis), so the secrets URL was `/workers/scripts//secrets` with an empty name, which the CF API misrouted to the script-upload endpoint. Fixed: read the name from `env.WORKER_NAME` (new `[vars]` entry, rendered from `worker_name`), default `afk-launcher`. Touches `worker/cloudflare/src/launcher.ts`, `types.ts`, `wrangler.toml.template`.

**15.12 `afk secrets ls` shows an AWS "SSM PATH" column on CF ⏳ (cosmetic).** The table header is hardcoded for the AWS/SSM backend; on Cloudflare it prints `AFK_SECRET_<name>` under "SSM PATH". Harmless but misleading — the column should be backend-neutral (or omitted on CF).

**15.10 `afk destroy` (Cloudflare) now executes ✅ (fixed).** It previously only *printed* a wrangler sequence — which was also incomplete (wrong KV flag, and it omitted the Container application + golden images, leaving Container instances billing). `afk destroy --yes` now actually tears down golden image tags, the launcher Worker, the Container app, D1, and KV; `afk destroy` (no flag) is a dry-run. Symmetric with `afk provision`. Touches `cli/src/services/BootstrapService.ts:destroyCloudflare`.

**15.6 update (token scope message) ✅ (partial).** `afk init`'s missing-token error now lists `Cloudflare Images:Edit`. The README prerequisites list still needs the same addition (Images + Workers Containers for the push; Access: Service Tokens for `team add`).

---

## 13. Operability nits

- **Region as a Layer.** ⏳ Every adapter currently takes `region` as a parameter to every method. A `RegionContext` Layer set from `ConfigService.load` would clean ~50 call sites.
- **`afk logs` time window flag.** ✅ `--since <duration>` (default 30d).
- **`afk init` re-run UX.** ✅ Each step's idempotency is now surfaced in the output (`created` vs `already present`).
- **YAML parser for compose.** ⏳ See #6; would also let us inject `command: ${AFK_COMMAND}` and `env_file:` automatically instead of erroring.
- **Better `afk run` error when git credential helper is broken.** ✅ `gh auth setup-git` is surfaced as a hint on common credential failures.

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
