# ADR Format

ADRs (Architecture Decision Records) live in `docs/adr/` with sequential numbering: `0001-slug.md`, `0002-slug.md`, … Create the `docs/adr/` directory lazily — only when the first ADR is needed.

## Template

```md
# {Short title of the decision}

{1–3 sentences: the context, what was decided, and why.}
```

That's it. An ADR can be a single paragraph. The value is in recording _that_ a decision was made and _why_ — not in filling out sections.

## Optional sections

Include these only when they add genuine value. Most ADRs won't need them.

- **Status** frontmatter (`proposed | accepted | deprecated | superseded by ADR-NNNN`) — useful once decisions start getting revisited.
- **Considered Options** — only when the rejected alternatives are worth remembering.
- **Consequences** — only when non-obvious downstream effects need calling out.

## Numbering

Scan `docs/adr/` for the highest existing number and increment by one.

## When to offer an ADR

All three must be true:

1. **Hard to reverse** — the cost of changing your mind later is meaningful.
2. **Surprising without context** — a future reader will look at the code and wonder _"why on earth did they do it this way?"_
3. **The result of a real trade-off** — there were genuine alternatives and you picked one for specific reasons.

If it's easy to reverse, skip it — you'll just reverse it. If it's not surprising, nobody will wonder why. If there was no real alternative, there's nothing to record beyond "we did the obvious thing."

### What qualifies

- **Architectural shape.** _"Commands depend only on Backend-neutral tags; provider code is chosen once at startup."_ The kind of decision `docs/architecture.md` exists to explain.
- **Backend / integration patterns.** _"Cloudflare augments every compose service with `network_mode: host` at submit time rather than requiring dev changes."_
- **Technology choices that carry lock-in** — the ones that would take a quarter to swap, not every library.
- **Boundary and scope decisions.** _"Session Artifacts are collected from the main service only, never sidecars."_ The explicit no-s are as valuable as the yes-s.
- **Deliberate deviations from the obvious path.** _"Retention is Local-only because Spot capacity can't be stopped without losing its disk."_ Anything where a reasonable reader would assume the opposite, so the next engineer doesn't "fix" something deliberate.
- **Constraints not visible in the code** — compliance, latency budgets, partner-API contracts.
- **Rejected alternatives when the rejection is non-obvious** — otherwise someone re-proposes it in six months.
