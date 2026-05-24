# Documentation

Technical documentation for the `afk` codebase. These docs are the binding
layer: they explain *how the code is shaped and why*, so that any change —
human or agent — lands in the same grain as everything around it.

Read in this order:

1. **[architecture.md](./architecture.md)** — the shape of the system. Layers,
   the Backend abstraction, how Effect `Layer`s are composed in `cli.ts`, and
   the path a request takes from a CLI flag to a launched Run. Start here to
   understand where a given piece of code belongs.

2. **[code-style.md](./code-style.md)** — how we write the code. Effect-TS
   idioms, error modelling, naming, formatting, comments. This is enforced
   strictly; a change that is correct but off-style is not done.
