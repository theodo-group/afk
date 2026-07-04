---
name: grill-with-docs
description: A relentless interview to sharpen a plan or design that also writes the project's domain docs — the CONTEXT.md glossary and ADRs — as decisions crystallize. Use when the user wants to grill a plan and capture the language and load-bearing decisions it produces.
disable-model-invocation: true
---

# Grill With Docs

Run a [grilling](../grill/SKILL.md) session — the same relentless, one-question-at-a-time interview down the design tree — but treat the conversation as a chance to **actively build the project's domain model**. As terms get pinned down and decisions get made, write them into the docs _inline, the moment they crystallize_. Don't batch them for the end.

This is the _active_ discipline. Merely reading `CONTEXT.md` for vocabulary is a one-line habit any skill can do; here you are _changing_ the model, not just consuming it.

## Where the docs live

Most repos have a single context: a `CONTEXT.md` at the repo root (the glossary) and ADRs under `docs/adr/`.

If a `CONTEXT-MAP.md` exists at the root, the repo has multiple contexts and the map points to where each glossary lives — read it to find the right `CONTEXT.md` for the topic under discussion, and ask if it's unclear which one applies.

Create files lazily — only when you have something to write. No `CONTEXT.md`? Create it when the first term is resolved. No `docs/adr/`? Create it when the first ADR is needed.

## During the session

Grill as normal, and let these side effects happen inline:

### Challenge language against the glossary

When the user uses a term that conflicts with an existing entry in `CONTEXT.md`, call it out immediately: _"The glossary defines Retention as X, but you seem to mean Y — which is it?"_ A grilling is where language drift gets caught.

### Sharpen fuzzy terms

When the user reaches for a vague or overloaded word, propose a precise canonical term: _"You're saying 'account' — do you mean the Owner or the developer's principal? Those are different things."_ Then write the resolved term into `CONTEXT.md` using the format in [CONTEXT-FORMAT.md](./CONTEXT-FORMAT.md).

### Stress-test relationships with concrete scenarios

When domain relationships are on the table, invent specific scenarios that probe the edges and force the user to be precise about where one concept ends and the next begins.

### Cross-reference against the code

When the user states how something works, check whether the code agrees. If it doesn't, surface the contradiction: _"The code self-terminates every cloud Run on exit, but you just said a cloud Run can be resumed — which is right?"_

### Keep CONTEXT.md a glossary, nothing else

`CONTEXT.md` is a glossary of canonical domain terms and **nothing else** — totally devoid of implementation details. Do not treat it as a spec, a scratchpad, or a home for implementation decisions. Those go in code, or in an ADR.

### Offer ADRs sparingly

Only offer to record an ADR when **all three** are true — hard to reverse, surprising without context, and the result of a real trade-off. If any one is missing, skip it. Use the format and the full test in [ADR-FORMAT.md](./ADR-FORMAT.md).

## Stopping condition

Same as a plain grilling: don't enact the plan until the user confirms a shared understanding. By then the glossary and any ADRs should already be written — that's the point of doing it inline.
