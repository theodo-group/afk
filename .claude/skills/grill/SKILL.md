---
name: grill
description: A relentless interview that stress-tests a plan or design before any code is written. Use when the user wants to pressure-test an approach, walk the design tree, or uses any 'grill' trigger phrase ("grill me", "grill this plan", "poke holes in this").
---

# Grill

Interview the user relentlessly about every aspect of the plan until you reach a **shared understanding**. The goal is to surface the decisions, dependencies, and unstated assumptions _before_ anything is built — not to enact the plan.

## How to run it

Walk down each branch of the design tree, resolving dependencies between decisions one at a time. Start at the load-bearing decisions (the ones every other choice hangs off), and only descend into a branch once its parent is settled.

- **One question at a time.** Ask a single question, then wait for the answer before moving on. Asking several at once is bewildering and produces shallow answers.
- **Recommend an answer.** For every question, give your own recommended answer and the reasoning behind it. A grilling is a conversation between two people who care about the design, not an interrogation from a blank clipboard.
- **Explore the codebase instead of asking, when you can.** If a question is answerable by reading the code (how does X currently work? does this seam already exist?), go read it rather than making the user recite it. Use the `Explore` subagent for anything that spans many files.
- **Chase the fuzzy word.** When the user reaches for a vague or overloaded term, stop and pin it down. Precise language now prevents a wrong build later.
- **Follow the friction.** When an answer opens a new branch of the tree, descend into it. Don't move on until the branch is resolved.

## Stopping condition

Do **not** enact the plan until the user confirms you've reached a shared understanding. When you believe you're there, say so explicitly and let the user confirm — the end of a grilling is a deliberate handshake, not a silent transition into building.
