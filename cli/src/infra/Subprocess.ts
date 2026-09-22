import { Context, Effect, Layer } from "effect"
import { SubprocessError, ParseError } from "./Errors.ts"

export interface RunOptions {
  readonly cwd?: string
  readonly env?: Record<string, string>
  readonly stdin?: string
  readonly inheritStdio?: boolean
}

export interface RunResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

export class Subprocess extends Context.Tag("Subprocess")<
  Subprocess,
  {
    readonly run: (
      command: string,
      args: ReadonlyArray<string>,
      options?: RunOptions,
    ) => Effect.Effect<RunResult, SubprocessError>

    readonly runJson: <T = unknown>(
      command: string,
      args: ReadonlyArray<string>,
      options?: RunOptions,
    ) => Effect.Effect<T, SubprocessError | ParseError>

    /** Inherits stdio so the child owns the TTY (interactive shells). */
    readonly runInteractive: (
      command: string,
      args: ReadonlyArray<string>,
      options?: RunOptions,
    ) => Effect.Effect<void, SubprocessError>

    /**
     * Long-lived inherited-stdio process (log follows, attaches) that is killed
     * when the surrounding Effect is interrupted — e.g. when a streamer stops
     * its tail because the Run reached a terminal state, or on Ctrl-C. Unlike
     * `runInteractive` (which leaks the child past interruption), `stream`
     * registers a finalizer that terminates the child.
     */
    readonly stream: (
      command: string,
      args: ReadonlyArray<string>,
      options?: RunOptions,
    ) => Effect.Effect<void, SubprocessError>
  }
>() {}

const stream = (
  command: string,
  args: ReadonlyArray<string>,
  options: RunOptions = {},
): Effect.Effect<void, SubprocessError> =>
  Effect.async<void, SubprocessError>((resume) => {
    // biome-ignore lint/plugin/no-bun-spawn: this file is the single sanctioned home for Bun.spawn (code-style.md §5)
    const proc = Bun.spawn([command, ...args], {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    })
    proc.exited.then(
      (code) =>
        // 130/143 = SIGINT/SIGTERM: a deliberate stop, not a failure.
        resume(
          code === 0 || code === 130 || code === 143
            ? Effect.void
            : Effect.fail(
                new SubprocessError({
                  command,
                  args,
                  exitCode: code,
                  stdout: "",
                  stderr: "",
                }),
              ),
        ),
      (cause) =>
        resume(
          Effect.fail(
            new SubprocessError({
              command,
              args,
              exitCode: -1,
              stdout: "",
              stderr: String(cause),
            }),
          ),
        ),
    )
    return Effect.sync(() => {
      try {
        proc.kill()
      } catch {
        /* already gone */
      }
    })
  })

const spawn = (
  command: string,
  args: ReadonlyArray<string>,
  options: RunOptions = {},
  capture: boolean,
  // Where an INHERITED child's stdout goes. "inherit" is our own stdout, 2 is
  // our stderr — see `makeSubprocessLive`. Ignored when `capture` is true.
  inheritedStdout: "inherit" | 2 = "inherit",
): Effect.Effect<RunResult, SubprocessError> =>
  Effect.tryPromise({
    try: async () => {
      // biome-ignore lint/plugin/no-bun-spawn: this file is the single sanctioned home for Bun.spawn (code-style.md §5)
      const proc = Bun.spawn([command, ...args], {
        cwd: options.cwd,
        env: options.env ? { ...process.env, ...options.env } : process.env,
        stdin: options.stdin ? "pipe" : capture ? "ignore" : "inherit",
        stdout: capture ? "pipe" : inheritedStdout,
        stderr: capture ? "pipe" : "inherit",
      })
      if (options.stdin && proc.stdin) {
        proc.stdin.write(options.stdin)
        proc.stdin.end()
      }
      const [stdout, stderr, exitCode] = await Promise.all([
        // `capture` is what made stdout a "pipe" above, but the stdio union now
        // admits a file descriptor, which Bun's types no longer narrow for us.
        capture
          ? new Response(proc.stdout as ReadableStream<Uint8Array>).text()
          : Promise.resolve(""),
        capture ? new Response(proc.stderr).text() : Promise.resolve(""),
        proc.exited,
      ])
      return { stdout, stderr, exitCode }
    },
    catch: (cause) =>
      new SubprocessError({
        command,
        args,
        exitCode: -1,
        stdout: "",
        stderr: String(cause),
      }),
  }).pipe(
    Effect.flatMap((result) =>
      result.exitCode === 0
        ? Effect.succeed(result)
        : Effect.fail(
            new SubprocessError({
              command,
              args,
              exitCode: result.exitCode,
              stdout: result.stdout,
              stderr: result.stderr,
            }),
          ),
    ),
  )

/**
 * `--json` promises a stdout that parses. But `runInteractive` hands the child
 * our own stdout, and build tooling writes to it: `docker push` opens with "The
 * push refers to repository [...]", which lands ahead of the JSON and makes the
 * whole stream unparseable for any programmatic caller.
 *
 * So in json mode an inherited child's stdout is redirected to fd 2 — the
 * developer still sees the build, and stdout carries nothing but our payload.
 *
 * `stream` is deliberately left alone: there the child's output IS the answer
 * (`afk logs --follow`), so diverting it would empty the stdout it exists to
 * fill.
 */
export const makeSubprocessLive = (
  mode: "table" | "json",
): Layer.Layer<Subprocess> => {
  const inheritedStdout = mode === "json" ? 2 : "inherit"
  return Layer.succeed(
    Subprocess,
    Subprocess.of({
      run: (command, args, options) => spawn(command, args, options, true),
      runJson: <T = unknown>(
        command: string,
        args: ReadonlyArray<string>,
        options?: RunOptions,
      ) =>
        spawn(command, args, options, true).pipe(
          Effect.flatMap((result) =>
            Effect.try({
              try: () => JSON.parse(result.stdout) as T,
              catch: (cause) =>
                new ParseError({
                  source: `${command} ${args.join(" ")}`,
                  cause,
                }),
            }),
          ),
        ),
      runInteractive: (command, args, options) =>
        spawn(command, args, options, false, inheritedStdout).pipe(
          Effect.asVoid,
        ),
      stream,
    }),
  )
}

/** Human mode: every inherited child writes to the terminal it was given. */
export const SubprocessLive = makeSubprocessLive("table")

/** Helper for use inside services: succeed if the program is on PATH. */
export const checkBinary = (
  command: string,
): Effect.Effect<boolean, never, Subprocess> =>
  Effect.gen(function* () {
    const sub = yield* Subprocess
    return yield* sub.run("which", [command]).pipe(
      Effect.map(() => true),
      Effect.catchAll(() => Effect.succeed(false)),
    )
  })
