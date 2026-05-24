# Code style

House style for `afk`. New code should be indistinguishable from what surrounds it; when in doubt, match the nearest file in the same tier. Citations point at real examples.

## Principles

Non-negotiable; the reason for most rules below.

- **Functional all the way.** Pure functions, immutable data, side effects at the edges through Effect. No mutable shared state. The only classes are `Context.Tag` and `Data.TaggedError` — never classes-with-behaviour.
- **Composition, never inheritance.** Assemble behaviour from small services/layers and piped functions. No class hierarchy, ever.
- **Code reads as a pipeline.** Data flowing through transformations (`.pipe`, `Effect.gen`), not imperative blocks mutating locals.
- **Domain-Driven naming.** Use the glossary's words (Run, Run Plan, Backend, Owner, Golden Image, Ref). Need a word it lacks? Add it to the glossary first. Name the domain intent, not the mechanism.

## 1. Formatting

Biome enforces it (`cli/biome.json`): `bun run format` writes, `format:check` verifies. Don't reformat surrounding code. Biome's linter is off; house rules run as GritQL plugins under `cli/lint/` (`bun run lint`):

We have grit for rules that can't be enforced with formatting alone inside the lint folder.

## 2. Naming

- **Services / adapters / tags / schemas:** `PascalCase`; file named after its primary export (`Git.ts` → `Git`).
- **Layers:** name + `Live` (`GitLive`, `AwsBackendLive`). A layer _factory_ is `makeXxxLive`.
- **Backend impls:** provider prefix + interface (`AwsCompute` / `AwsComputeLive`).
- **Constants:** `SCREAMING_SNAKE_CASE`, all in `constants.ts`.
- **Locals:** `camelCase`; short abbreviations for yielded tags fine (`const cfg = yield* ConfigService`).

## 3. Types & immutability

`strict` + `noUncheckedIndexedAccess` + `noFallthroughCasesInSwitch`.

- `readonly` on every field, property, and object-typed parameter.
- `ReadonlyArray<T>`, never `T[]`, at boundaries.
- `import type` for type-only imports.
- Indexed access is `T | undefined`; `!` only after proving presence.

## 4. Effect idioms

**Service** — `Context.Tag` class, interface inline as second type param, every member `readonly`, tag string = class name:

```ts
export class Subprocess extends Context.Tag("Subprocess")<
  Subprocess,
  { readonly run: (cmd: string, args: ReadonlyArray<string>) => Effect.Effect<RunResult, SubprocessError> }
>() {}
```

**Layer** — `Layer.effect` when it needs other tags (`Effect.gen` that `yield*`s deps, returns `Tag.of({…})`); `Layer.succeed` when it needs nothing. Always wrap the impl in `Tag.of({…})`.

```ts
export const GitLive = Layer.effect(
  Git,
  Effect.gen(function* () {
    const sub = yield* Subprocess
    return Git.of({ /* … */ })
  }),
)
```

**`gen` vs `.pipe`** — pick by readability. `gen` for imperative multi-step flows (command handlers, constructors); `.pipe` for single-value transform chains. Don't mix in one small op. Break long pipes one operator per line.

**Pipelines over accumulator loops.** When a body's job is to _build a value_ (assemble a list, run checks, collect results), compose small named steps — don't push into a mutable local. Lift each unit to a named `Effect<T>`, assemble with `Effect.all` + `Effect.map` (independent) or `Effect.flatMap` (genuine data dependency). Reader scans names for _what_, opens one body for _how_. A `for` over `results.push(…)` is the smell this replaces.

```ts
// avoid — intent buried in an accumulator
const checks = []
for (const svc of services) {
  checks.push(yield* probe(svc))
}

// prefer — each step named, assembly is one line
const probeAll = Effect.all(services.map(probe))
```

- Not Effect-specific — governs plain helpers too, including the pre-runtime zone (`projectConfig.ts`, the `cli.ts` Backend pick). A directory walk recursing to the filesystem root is tail-recursion, not a mutable loop (`findProjectRoot`).
- **Normalise so assembly is one flatten.** Mismatched shapes? Lift _every_ contributor to `Effect<ReadonlyArray<T>>` and finish `Effect.all([…]).pipe(Effect.map((gs) => gs.flat()))` — reads as "gather, flatten," not nesting + spreads (`CloudflareBackendDoctor.ts`).
- **Branch a loaded result with `Effect.matchEffect`**, not `Effect.either` + `_tag` (which buries the branch).
- **Exception:** a genuine dependent-effect chain (each `yield*` consumes the previous) — `gen` _is_ the readable form. A deadline-gated poll with a real sleep (`RunService.streamUntilTerminated`, `Ssm`'s wait) carries an explicit `// biome-ignore lint/plugin/noloops: <reason>`.

**Functional core, imperative shell.** Push pure decision logic out of the I/O `gen`.

- **Core** — plain function, data in/data out. No Effect, clock, randomness, I/O. Returns result _and failures_ as data (an `Either<T, UserError>`, or a record with an error field like `assembleRunPlan`'s `composeError`/`warnings`).
- **Shell** — the `Layer`/`gen`: `yield*`s effectful inputs, calls the core, performs the side effects its result gates, translates failures into the Effect channel. Non-deterministic seeds (`randomUUID()`, timestamps) are generated in the shell and _injected_, keeping the core deterministic.
- Reward: a `bun test` seam with **no Layer** — call the core, assert the return. Exemplar `backends/aws/AwsRunPlan.ts` (tested by `AwsRunPlan.test.ts`), with `AwsCompute.ts` the thin shell.
- Don't force it where nothing pure exists to extract (same exception as above).
- A core output crossing a `Record<string, unknown>` seam (e.g. `PreparedRun.backendPlan`): declare it a closed `type`, not `interface` — an interface's declaration-merging blocks direct assignment and forces a double cast. Unpack is a single `as` (in-process reassertion, not a trust boundary — no Schema decode).

**Errors**

- Every failure a `Data.TaggedError` in `infra/Errors.ts`, in the `AfkError` union — never scattered elsewhere.

  ```ts
  export class UserError extends Data.TaggedError("UserError")<{
    readonly message: string
    readonly hint?: string
  }> {}
  ```

- Computed messages via `override get message()`.
- **Never `throw`.** `Effect.fail(new XxxError({…}))`; convert foreign throwables via `Effect.try`/`tryPromise`'s `catch` or `Effect.mapError`.
- `UserError` is user-facing; when the dev can fix it, give a concrete `hint:`.
- Adapter errors wrap stderr with an `operation` label (`GitError`, `DockerError`).
- **Recovery** — `Effect.catchAll(() => Effect.succeed(fallback))` for best-effort reads only. Keep narrow; don't swallow errors you can act on.

## 5. Shelling out

All subprocess execution through the `Subprocess` tag — `Bun.spawn` only in `infra/Subprocess.ts`. `run`/`runJson` for captured output, `runInteractive` for TTY shells, `stream` for long-lived follows killed on interruption (registers a kill finalizer; `runInteractive` does not).

## 6. Schemas

- All in `schema/`, each paired with `typeof X.Type`.

  ```ts
  export const RunStatus = Schema.Literal("PROVISIONING", "RUNNING", "STOPPING", "STOPPED")
  export type RunStatus = typeof RunStatus.Type
  ```

- Branded types for identifiers (`Schema.String.pipe(Schema.brand("RunId"))`).
- Validate untrusted input with `Schema.decodeUnknown(X)(v).pipe(Effect.mapError(toDomainError))` — never a bare cast across a process/file boundary.

## 7. Commands (`@effect/cli`)

- One command per file; subcommand groups get a directory whose `index.ts` does `.pipe(Command.withSubcommands([…]))`.
- `Options`/`Args` as module-level consts, each `.withDescription`.

  ```ts
  const ref = Options.text("ref").pipe(Options.optional)
  const command = Args.text({ name: "command" }).pipe(Args.repeated)
  ```

- `Command.make(name, options, handler)`, handler an arrow returning `Effect.gen`. Optional flags arrive as `Option<T>` — unwrap via `._tag`.
- Handlers `yield*` services, route output through `Output.emit`, never `console.log`.

## 8. Comments

A cost. Only to explain **why something exists** — never how/what the code says. Before writing, ask: does this add what the code can't? If not, delete it.

- Restates the code → delete.
- Earns its place: design rationale, non-obvious constraints (usually JSDoc on an exported tag/interface).
- Section banners fine for long composition files (`cli.ts`).
- Inline `//`: lowercase, brief, rare.

## 9. Commits

[Conventional Commits](https://www.conventionalcommits.org): `<type>(<scope>): <subject>`.

- Types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `build`.
- Scope = area touched (`cli`, `worker`, `aws`, `docs`).
- Subject: imperative, lowercase, no trailing period.

## 10. Output & diagnostics

Two seams, no raw `console.*` elsewhere:

- **`Output`** (`infra/Output.ts`) — _results_, to stdout, `--json`-aware via `emit({ data, human })`. Keeps stdout clean JSON for `… --json | jq`.
- **`Logger`** (`infra/Logger.ts`) — _diagnostics_, to stderr, level-filtered. `Effect.logWarning`/`logInfo`/`logDebug`; it adds the prefix, so don't.

`console.*` allowed only inside those two sinks and the last-resort `catchAllCause` in `cli.ts` (runs outside all layers). A warning belongs on the Logger — routing it to stdout corrupts `--json`.

## 11. Don't

- Import a concrete backend (`AwsCompute`) outside `backends/aws/` — depend on the tag.
- `throw`, send results anywhere but `Output`, or `Bun.spawn` outside §5.
- Add an npm dependency without need (`cli/bunfig.toml` pins exact versions).
- Reformat unrelated code.
