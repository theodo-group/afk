# Improvements

Backlog of known gaps in the v2 implementation, ordered by value.
Bugs found during live testing are folded in where relevant.

**Status legend:** ✅ shipped · ⏳ pending · ⏸ deferred

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

## 9. Local Backend (`--local`) ⏸

**Gap.** README originally promised it; current implementation has no `--local` paths. Removed from the doc, but the design intent stands.

**Approach.** Implement per-command `--local` dispatch in each command module (or via a `Backend` interface that picks `CloudBackend` vs `LocalBackend` at the CLI entry point). Local should: build the wrapped image, resolve `ssm:` secrets client-side, `docker compose up --exit-code-from <main>` with labels for `afk ls --local` enumeration. `afk image build --local` refuses with a clear message.

**Touches:** new `cli/src/services/LocalBackend.ts`, dispatch logic in every `RunService`-fronted command.

---

## 10. Operability nits

- **Region as a Layer.** ⏳ Every adapter currently takes `region` as a parameter to every method. A `RegionContext` Layer set from `ConfigService.load` would clean ~50 call sites.
- **`afk logs` time window flag.** ✅ `--since <duration>` (default 30d).
- **`afk init` re-run UX.** ✅ Each step's idempotency is now surfaced in the output (`created` vs `already present`).
- **YAML parser for compose.** ⏳ See #6; would also let us inject `command: ${AFK_COMMAND}` and `env_file:` automatically instead of erroring.
- **Better `afk run` error when git credential helper is broken.** ✅ `gh auth setup-git` is surfaced as a hint on common credential failures.

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
