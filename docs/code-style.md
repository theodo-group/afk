# Code style

House style for the `afk` codebase. Every rule here is already followed by the
existing code; new code should be indistinguishable from what surrounds it.
When in doubt, match the nearest file in the same tier. Citations point at real
examples.

## Principles

Non-negotiable, and the reason for most rules below:

- **Functional, all the way.** Pure functions, immutable data, side effects
  pushed to the edges through Effect. No mutable shared state. The only classes
  are `Context.Tag` service definitions and `Data.TaggedError` — never
  classes-as-objects with behaviour.
- **Composition over inheritance, always.** Behaviour is assembled by composing
  small services and layers and by piping functions — never by subclassing.
  There is no class hierarchy and there should never be one.
- **Code reads as a pipeline.** Express logic as data flowing through
  transformations (`.pipe(…)` chains, `Effect.gen` sequences), not as imperative
  blocks mutating locals.
- **Domain-Driven naming.** Every name — service, function, type, variable,
  command — uses the project's ubiquitous language (Run, Run Plan, Backend,
  Owner, Golden Image, Ref, …). If a concept has a glossary term, use that exact
  word; if you need a word the glossary lacks, add it to the glossary first.
  Names describe domain intent, not mechanism.

## 1. Formatting

| Thing | Rule |
| --- | --- |
| Quotes | Double — `"effect"`, never `'effect'` |
| Semicolons | **None** (ASI) |
| Indentation | 2 spaces, no tabs |
| Trailing commas | On every multi-line array / object / param list |
| Line width | ~80; long Effect pipelines break one operator per line |
| Imports | Explicit `.ts` extension — `from "./X.ts"` (Bun resolver) |

No Prettier/ESLint config is committed — the existing output *is* the
convention. Don't reformat surrounding code.

## 2. Naming

- **Services, adapters, tags, schemas:** `PascalCase`; file named after its
  primary export (`Git.ts` → `Git`, `RunService.ts` → `RunService`).
- **Layer exports:** name + `Live` (`GitLive`, `RunServiceLive`, `AwsBackendLive`).
  A layer *factory* is `makeXxxLive` (`makeOutputLive`).
- **Constants:** `SCREAMING_SNAKE_CASE`, all in `constants.ts`.
- **Backend impls:** provider prefix + interface (`AwsCompute` / `AwsComputeLive`).
- **Locals:** `camelCase`. Short abbreviations for yielded tags are fine
  (`const cfg = yield* ConfigService`, `const sub = yield* Subprocess`).

## 3. Types & immutability

`tsconfig.json` is `strict` + `noUncheckedIndexedAccess` +
`noFallthroughCasesInSwitch`.

- **`readonly` on everything** — every field, object property, and object-typed
  parameter (`infra/Subprocess.ts`, `services/backend/Compute.ts`).
- **`ReadonlyArray<T>`, never `T[]`** at every boundary.
- **`import type`** for type-only imports (satisfies `isolatedModules`).
- Indexed access is `T | undefined`; use `!` only after proving the element
  exists (`widths[i]!` in `infra/Output.ts`).

## 4. Effect-TS idioms

**Defining a service** — a `Context.Tag` class, interface inline as the second
type param, every member `readonly`, tag string = class name:

```ts
export class Subprocess extends Context.Tag("Subprocess")<
  Subprocess,
  { readonly run: (cmd: string, args: ReadonlyArray<string>) => Effect.Effect<RunResult, SubprocessError> }
>() {}
```

**Providing it as a Layer:**

- `Layer.effect` when it needs other tags — body is an `Effect.gen` that
  `yield*`s deps and returns `Tag.of({ … })`:
  ```ts
  export const GitLive = Layer.effect(
    Git,
    Effect.gen(function* () {
      const sub = yield* Subprocess
      return Git.of({ /* … */ })
    }),
  )
  ```
- `Layer.succeed` when it needs nothing (`SubprocessLive`, `makeOutputLive`).
- Always wrap the impl in `Tag.of({ … })` for the field types.

**`Effect.gen` vs `.pipe`** — both are used; pick by readability:

- `Effect.gen(function* () { … })` for imperative multi-step flows (command
  handlers, service constructors).
- `.pipe(Effect.map(…), Effect.flatMap(…))` for single-value transform chains
  (`GitLive` operations, error remapping).

Don't mix them in one small operation. Break long pipes one operator per line.

**Prefer pipelines of named steps over accumulator loops.** When a `gen` body's
job is to *build a value* — assemble a list, run a series of checks, collect
results — reach for a pipeline before an imperative `gen` that pushes into a
mutable local. The Effect [building pipelines][pipelines] guide is the rule of
thumb: decompose the work into small named functions and compose them with
`pipe`/`map`/`flatMap`, so the body reads as data flowing left-to-right and each
step is independently nameable, instead of a block mutating an accumulator.

- Lift each unit of work to a named `Effect<T>` value (often a module-level pure
  function returning the `Effect`), then assemble with `Effect.all` + `Effect.map`
  for independent steps and `Effect.flatMap` for a genuine data dependency (one
  step gates the next). The reader scans the names to see *what* runs and opens
  the one body they care about to see *how*.
- A `for` loop over `results.push({ … })` inside a `gen` is the smell this
  replaces — the intent of each step is buried in punctuation and ordering. The
  exception is a real imperative dependency chain (each `yield*` consumes the
  previous), where `gen` *is* the readable form.
- `Effect`s are immutable values: composing them returns new effects, never
  mutating. That is what makes the small-functions-then-compose shape safe and
  why it is the default.
- **Normalise the pieces so the assembly is one flatten.** When the steps
  produce different shapes — one yields a `T`, another a `ReadonlyArray<T>` —
  lift *every* contributor to `Effect<ReadonlyArray<T>>` and finish with
  `Effect.all([…]).pipe(Effect.map((groups) => groups.flat()))`. The mismatched
  form, `Effect.flatMap((a) => other.pipe(Effect.map((b) => [...a, ...b])))`,
  reads as nesting and spreads; uniform-then-flatten reads as "gather, flatten."
  (`backends/cloudflare/CloudflareBackendDoctor.ts`.)
- **Branch on a loaded result with `Effect.matchEffect`, not `Effect.either` +
  `_tag`.** `x.pipe(Effect.matchEffect({ onFailure, onSuccess }))` destructures
  the success value directly in `onSuccess`; the `Effect.either` →
  `loaded._tag === "Right"` → `loaded.right` form is ceremony that buries the
  branch (same file).

[pipelines]: https://effect.website/docs/getting-started/building-pipelines/

**Functional core, imperative shell.** Push pure decision logic *out* of the
`Effect.gen` that performs the I/O. A service method that gathers effectful
inputs (config, identity, files, network) and *also* computes the plan inline —
resolving defaults, validating, assembling records — tangles two concerns and
leaves the pure part unreachable without standing up the whole Layer. Split them:

- The **core** is a plain function: data in, data out. No `Effect`, no clock, no
  randomness, no I/O. It returns its result *and its failures* as data — an
  `Either<T, UserError>`, or a result record with an error field (as
  `assembleRunPlan` returns `composeError` / `warnings`). The shell translates
  that into the Effect channel (`yield* Effect.fromEither(…)`, or
  `Effect.fail`/`console.warn` on the surfaced fields).
- The **shell** is the `Layer` / `Effect.gen`: it `yield*`s the effectful inputs,
  calls the core, and performs the side effects the core's result gates. The
  non-deterministic seeds (`randomUUID()`, `new Date().toISOString()`) are
  generated in the shell and *injected* into the core, so the core stays
  deterministic.
- The reward is a `bun test` seam with **no Layer**: call the core with plain
  inputs and assert on the returned value. Exemplar: `backends/aws/AwsRunPlan.ts`
  (`planAwsRun` / `finalizeAwsPlan` / `toRunStarted`) tested by
  `AwsRunPlan.test.ts`, with `backends/aws/AwsCompute.ts` as the thin shell
  (gather → core → gated effects → finalize).
- Don't force it where there is nothing pure to extract. A method that is a
  genuine chain of dependent effects with no inlined decision logic is already a
  correct shell — leave it (the same exception as the accumulator-loop rule).
- When the core's output rides through a neutral opaque seam typed
  `Record<string, unknown>` (e.g. `PreparedRun.backendPlan`), declare that record
  as a closed `type` alias, not an `interface`: an interface can be augmented by
  declaration merging so TS refuses to assign it to the record, forcing an
  `as unknown as` double-cast; a `type` is closed and assigns directly. The
  unpack on the consuming side is then a single `as` (an in-process reassertion,
  not a trust boundary — so no Schema decode is warranted).

**Errors:**

- Every failure is a `Data.TaggedError` in `infra/Errors.ts`, added to the
  `AfkError` union — never scattered into other files.
  ```ts
  export class UserError extends Data.TaggedError("UserError")<{
    readonly message: string
    readonly hint?: string
  }> {}
  ```
- Computed messages use `override get message()` (`SubprocessError`, `ParseError`).
- **Never `throw`.** Produce with `Effect.fail(new XxxError({…}))`; convert
  foreign throwables via `Effect.try`/`Effect.tryPromise`'s `catch` or
  `Effect.mapError`.
- **`UserError`** is the user-facing one; when the developer can fix it, give a
  `hint:` with the concrete next step ("Run `afk init` to scaffold one.").
- Adapter errors wrap the tool's stderr with an `operation` label (`GitError`,
  `DockerError`, `AwsError`) — see `GitLive`'s `exec` helper.

**Recovery** — `Effect.catchAll(() => Effect.succeed(fallback))` for best-effort
reads (e.g. polling that survives transient errors). Keep it narrow; don't
swallow errors you can act on.

## 5. Shelling out

All subprocess execution goes through the `Subprocess` tag — `Bun.spawn` lives
only in `infra/Subprocess.ts`, never raw in services, adapters, or commands. Use
`run`/`runJson` for captured output, `runInteractive` for TTY-owning shells, and
`stream` for long-lived follows that must be killed when the surrounding Effect
is interrupted (it registers a kill finalizer; `runInteractive` does not).

## 6. Schemas (effect Schema)

- All `Schema` definitions live in `schema/`, each paired with `typeof X.Type`:
  ```ts
  export const RunStatus = Schema.Literal("PROVISIONING", "RUNNING", "STOPPING", "STOPPED")
  export type RunStatus = typeof RunStatus.Type
  ```
- **Branded types** for identifiers (`Schema.String.pipe(Schema.brand("RunId"))`).
- Validate untrusted input (config, JSON payloads) with
  `Schema.decodeUnknown(X)(value).pipe(Effect.mapError(toDomainError))` — never a
  bare cast across a process or file boundary.

## 7. Commands (`@effect/cli`)

- One command per file in `commands/`; subcommand groups get a directory whose
  `index.ts` root command does `.pipe(Command.withSubcommands([…]))`.
- Declare `Options`/`Args` as module-level consts, each with a
  `withDescription`:
  ```ts
  const ref = Options.text("ref").pipe(Options.optional)
  const command = Args.text({ name: "command" }).pipe(Args.repeated)
  ```
- Build with `Command.make(name, options, handler)`, handler an arrow returning
  `Effect.gen`. Optional flags arrive as `Option<T>` — unwrap via
  `._tag === "Some"`.
- Handlers `yield*` services and route output through `Output.emit`, never
  `console.log`.

## 8. Comments

Comments are a cost. Use them sparingly, only to explain **why something
exists** — never how or what the code already says. Before writing one, ask:
*does this add understanding the code itself cannot?* If not, delete it.

- A comment that restates the code earns deletion.
- The ones that earn their place capture design rationale and non-obvious
  constraints (why `prepare`/`launch` are split, why the Backend is picked
  synchronously). JSDoc on an exported tag/interface is their usual home.
- Section banners (`// ---------- Layer composition ----------`) are fine for
  navigating long composition files like `cli.ts`.
- Inline `//` comments: lowercase, brief, rare.

## 9. Commits

[Conventional Commits](https://www.conventionalcommits.org):
`<type>(<scope>): <subject>`.

- Types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `build`.
- Scope is the area touched (`cli`, `worker`, `aws`, `docs`, …) — encouraged.
- Subject: imperative mood, lowercase, no trailing period.

E.g. `feat(cli): one-command provisioning`,
`fix(worker): resolve own script name from env for /secrets routes`.

## 10. Don't

- Import a concrete backend (`AwsCompute`) outside `backends/aws/` — depend on
  the tag.
- `throw`, `console.log` results, or use `Bun.spawn` outside the documented spots.
- Add an npm dependency without need; `cli/bunfig.toml` pins exact versions
  (`exact = true`) — keep it.
- Reformat unrelated code in a change.
