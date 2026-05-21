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
    /** Run a command, capturing stdout/stderr. Fails on non-zero exit. */
    readonly run: (
      command: string,
      args: ReadonlyArray<string>,
      options?: RunOptions,
    ) => Effect.Effect<RunResult, SubprocessError>

    /** Run a command and parse stdout as JSON. Fails on non-zero exit or bad JSON. */
    readonly runJson: <T = unknown>(
      command: string,
      args: ReadonlyArray<string>,
      options?: RunOptions,
    ) => Effect.Effect<T, SubprocessError | ParseError>

    /** Run a command attached to the user's TTY (for interactive sessions). Fails on non-zero exit. */
    readonly runInteractive: (
      command: string,
      args: ReadonlyArray<string>,
      options?: RunOptions,
    ) => Effect.Effect<void, SubprocessError>
  }
>() {}

const spawn = (
  command: string,
  args: ReadonlyArray<string>,
  options: RunOptions = {},
  capture: boolean,
): Effect.Effect<RunResult, SubprocessError> =>
  Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn([command, ...args], {
        cwd: options.cwd,
        env: options.env ? { ...process.env, ...options.env } : process.env,
        stdin: options.stdin ? "pipe" : capture ? "ignore" : "inherit",
        stdout: capture ? "pipe" : "inherit",
        stderr: capture ? "pipe" : "inherit",
      })
      if (options.stdin && proc.stdin) {
        proc.stdin.write(options.stdin)
        proc.stdin.end()
      }
      const [stdout, stderr, exitCode] = await Promise.all([
        capture ? new Response(proc.stdout).text() : Promise.resolve(""),
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

export const SubprocessLive = Layer.succeed(
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
      spawn(command, args, options, false).pipe(Effect.asVoid),
  }),
)

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
