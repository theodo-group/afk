# Git-host integrations

Trigger `afk run` from a pull/merge request comment, the way you comment a task
at the Claude GitHub app.

## How it works (and what it deliberately isn't)

This is **CI-native**: a reusable GitHub Action and a GitLab CI template that run
on your host's CI runner. There is **no afk-operated server** and no webhook
receiver to host — which is what keeps triggering identical across every Backend
(AWS, GCP, Cloudflare, Local), since it is just the CLI running in CI. The trade
against the hosted-App UX (zero per-repo setup) is deliberate; backend-neutrality
won.

The flow on a `@afk <task>` comment:

1. **Parse** — only PR/MR comments starting with the trigger phrase proceed.
2. **Authorize** — the commenter must have write/maintain/admin (GitHub) or
   Developer+ (GitLab); everyone else is silently ignored. This gate is what
   makes the feature safe on public repos — a comment launches cloud compute
   under your CI credentials with your secrets injected.
3. **Resolve ref** — the Run executes against the PR/MR **head branch**. Fork
   PRs/MRs are rejected: their commits aren't on origin, which afk requires (and
   running fork code under your secrets would be unsafe anyway).
4. **Launch (fire-and-detach)** — the job runs `afk run`, posts the run id back
   to the thread, and exits in seconds. It does **not** wait for the Run.
5. **Completion** — reported by the Run's own workload (the agent has the git
   token), not by afk. afk owns the launch, not the feedback loop.

### Owner & intervention

The Run is Owned by the **CI principal** (the runner's ambient cloud
credentials), not the human commenter — so a teammate's laptop `afk attach` /
`afk kill` won't act on it (wrong Owner). The team still *sees* it via
`afk ls --all`. Intervention is fire-and-forget through the PR thread; a runaway
Run is bounded by its timeout. (kill/status comment verbs are not in v1.)

## Prerequisites

- The Backend is provisioned and a Golden Image exists for it.
- `afk.config.json` is committed at the repo root (CI checks out the head ref).
- Backend credentials are available to the CI job (AWS OIDC role, GCP Workload
  Identity Federation, or a Cloudflare token) — configure these **before** the
  afk step.
- Docker is available on the runner (afk builds the agent image).

## GitHub

See [`github/action.yml`](./github/action.yml) and copy
[`github/example-workflow.yml`](./github/example-workflow.yml) to
`.github/workflows/afk.yml`. GitHub's native `issue_comment` event drives it — no
extra wiring.

## GitLab — not yet supported

GitLab has **no native comment→pipeline trigger**: nothing in GitLab CI's
`rules:` fires on a comment. The only building blocks are webhooks (which POST a
*fixed* payload and can't remap fields into a pipeline trigger's `variables[...]`)
and trigger tokens — so bridging the two requires either a small stateless relay
function or a polling pipeline. Neither is purely CI-native, so GitLab is
deferred rather than shipped half-wired. Revisit when there's appetite for the
relay.
