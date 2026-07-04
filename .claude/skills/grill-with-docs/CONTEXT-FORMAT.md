# CONTEXT.md Format

`CONTEXT.md` is the glossary of canonical domain terms — the ubiquitous language. It is a glossary and **nothing else**: no implementation details, no spec, no decisions (those go in an ADR or the code).

## Structure

This project uses a **heading-per-term** glossary. Each term is an H2, followed by prose that defines what it _is_, with cross-references and a disambiguation line. Match the entries already in `CONTEXT.md`.

```md
# Context

{One line on what this glossary is.}

## Retention

{One to a few sentences defining the term — what it IS, not how it's built. Reference
related terms with wikilinks the first time they appear: a [[run]], the [[backend]].}

Not to be confused with: {the near-miss concepts a reader would confuse this with, and
the one distinction that separates them}.
```

## Rules

- **Be opinionated.** When several words exist for one concept, pick the canonical one and steer readers off the others — inline (_"Not to be confused with…"_) rather than a separate list.
- **Define what it IS, not what it does.** Name the domain intent, not the mechanism. Keep implementation out entirely — if a sentence explains _how_ something works, it belongs in code or an ADR, not here.
- **Cross-reference with `[[wikilinks]]`.** The first mention of another glossary term in an entry links to it (`[[golden-image]]`, `[[spot|Spot]]` when the display text differs from the anchor). This is what makes the glossary a navigable web rather than a flat list.
- **End contested terms with a "Not to be confused with" line.** The disambiguation is often the most valuable part of the entry — it's where language drift gets caught.
- **Only include terms specific to this project's domain.** General programming concepts (timeouts, error types, retries, utility patterns) don't belong even if the project leans on them heavily. Before adding a term ask: is this a concept unique to `afk`, or a general one? Only the former earns an entry.
- **Add the word before you use it.** Naming a module or seam after a concept that isn't in the glossary? Add the term here first, then use it — that's the discipline that keeps the language ubiquitous.

## Single vs multi-context repos

**Single context (this repo today):** one `CONTEXT.md` at the repo root.

**Multiple contexts:** a `CONTEXT-MAP.md` at the root lists the contexts, where each glossary lives, and how they relate. If it exists, read it to find the right `CONTEXT.md` for the topic; if the topic's context is unclear, ask. If neither a map nor a root `CONTEXT.md` exists, create the root `CONTEXT.md` lazily when the first term is resolved.
