# Cloud Runs may be retained, but only On-Demand and opt-in

## Status

accepted

## Context

afk originally never retained finished cloud Runs: on AWS and GCP every Run self-terminated the instant its command exited, and post-mortem inspection was unavailable (CONTEXT.md → Retention, pre-reversal). The reason was physical, not policy — cloud Runs default to **Spot** capacity, and a Spot instance cannot be stopped without losing its disk, so "stop-but-preserve" was impossible. Retention was therefore realized on the Local Backend only.

We now want **post-mortem connect**: `afk attach` into a finished cloud Run to inspect the state its command left behind (the motivating case being an interactive session whose timeout fired). That requires preserving the instance's disk past command-exit, which is only possible on capacity that can be stopped.

## Decision

Cloud retention is **opt-in via `afk run --retain`**, and `--retain` **implies On-Demand** capacity. A retained Run **stops** its instance on exit instead of terminating it, preserving the disk; `afk attach` then resumes the instance for the duration of the attach session and drops the developer into the exited container's post-mortem filesystem (commit-and-run, mirroring the Local Backend), stopping it again on detach. A retained instance is reclaimed by `afk kill` or by a **period-based reaper** (default 7-day retention period).

- `--retain --spot` is a **hard error** — Spot physically cannot stop-preserve.
- **Cloudflare is excluded**: its Container instances are ephemeral, so there is no stop-preserve primitive; CF stays live-attach-only.
- Retention is **off by default** because a stopped instance still bills for its disk.

## Considered options

- **Session Artifacts / snapshot only** — rejected: gives the developer files, not a shell into the finished environment. (Session Artifacts remain the way to carry state past a *non-retained* Run's end.)
- **Retain every On-Demand Run by default** — rejected: stopped EBS/PD volumes accrue cost silently across a team.
- **Retain on Spot** — physically impossible (the original constraint).

## Consequences

- **GCP** reverses a previously documented posture: the reconcile Cloud Function's `afk-sweeper` SA was read-only ("No delete"); the reaper now needs **`compute.instances.delete`**, and the Run SA needs **`compute.instances.stop`** — both kept tightly scoped to `afk-run`-labelled VMs only.
- **AWS** sweeper Lambda gains one query (retained + older than period → terminate); it already holds `TerminateInstances`. Retained Runs launch with `InstanceInitiatedShutdownBehavior=stop`.
- Stopped instances incur disk cost until reaped — surfaced in the backend docs.
- Post-mortem attach behavior becomes **uniform across all four backends** (Local already did commit-and-run on retained Runs).
