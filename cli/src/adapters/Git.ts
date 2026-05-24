import { Context, Effect, Layer } from "effect"
import { Subprocess } from "../infra/Subprocess.ts"
import { GitError, UserError } from "../infra/Errors.ts"

export class Git extends Context.Tag("Git")<
  Git,
  {
    readonly isClean: Effect.Effect<boolean, GitError>
    readonly currentBranch: Effect.Effect<string, GitError>
    readonly headSha: Effect.Effect<string, GitError>
    /** Resolve a ref against origin (fetches metadata; never mutates working tree). */
    readonly resolveRemoteRef: (
      gitUrl: string,
      ref: string,
    ) => Effect.Effect<string, GitError | UserError>
    readonly remoteHasSha: (
      gitUrl: string,
      sha: string,
    ) => Effect.Effect<boolean, GitError>
    readonly isTracked: (path: string) => Effect.Effect<boolean, GitError>
  }
>() {}

export const GitLive = Layer.effect(
  Git,
  Effect.gen(function* () {
    const sub = yield* Subprocess

    const exec = (args: ReadonlyArray<string>) =>
      sub
        .run("git", args)
        .pipe(
          Effect.mapError(
            (e) =>
              new GitError({ operation: args.join(" "), message: e.stderr }),
          ),
        )

    return Git.of({
      isClean: exec(["status", "--porcelain"]).pipe(
        Effect.map((r) => r.stdout.trim().length === 0),
      ),
      currentBranch: exec(["rev-parse", "--abbrev-ref", "HEAD"]).pipe(
        Effect.map((r) => r.stdout.trim()),
      ),
      headSha: exec(["rev-parse", "HEAD"]).pipe(
        Effect.map((r) => r.stdout.trim()),
      ),
      resolveRemoteRef: (gitUrl, ref) =>
        sub.run("git", ["ls-remote", gitUrl, ref]).pipe(
          Effect.mapError(
            (e) =>
              new GitError({
                operation: `ls-remote ${ref}`,
                message: e.stderr,
              }),
          ),
          Effect.flatMap((r) => {
            const line = r.stdout.trim().split("\n")[0]
            if (!line) {
              return Effect.fail(
                new UserError({
                  message: `ref '${ref}' not found on origin (${gitUrl})`,
                  hint: "Push the branch first, or pass a ref that exists on origin.",
                }),
              )
            }
            const sha = line.split(/\s+/)[0]!
            return Effect.succeed(sha)
          }),
        ),
      remoteHasSha: (gitUrl, sha) =>
        sub.run("git", ["ls-remote", gitUrl]).pipe(
          Effect.mapError(
            (e) => new GitError({ operation: "ls-remote", message: e.stderr }),
          ),
          Effect.map((r) =>
            r.stdout.split("\n").some((line) => line.startsWith(sha)),
          ),
        ),
      isTracked: (path) =>
        sub.run("git", ["ls-files", "--error-unmatch", path]).pipe(
          Effect.map(() => true),
          Effect.catchAll(() => Effect.succeed(false)),
        ),
    })
  }),
)
