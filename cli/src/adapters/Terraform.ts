import { Context, Effect, Layer } from "effect"
import { Subprocess } from "../infra/Subprocess.ts"
import { SubprocessError } from "../infra/Errors.ts"

export class Terraform extends Context.Tag("Terraform")<
  Terraform,
  {
    readonly version: Effect.Effect<string, SubprocessError>
    /**
     * Run `terraform destroy -auto-approve` in `dir`, streaming output to the
     * user's TTY. Re-inits first so a fresh checkout (no `.terraform/`) still
     * works. `vars` are passed as `-var k=v`.
     */
    readonly destroy: (input: {
      readonly dir: string
      readonly vars?: Record<string, string>
    }) => Effect.Effect<void, SubprocessError>
    /**
     * Run `terraform apply -auto-approve` in `dir`, streaming output to the
     * user's TTY. Re-inits first so a fresh checkout (no `.terraform/`) still
     * works. `vars` are passed as `-var k=v`.
     */
    readonly apply: (input: {
      readonly dir: string
      readonly vars?: Record<string, string>
    }) => Effect.Effect<void, SubprocessError>
  }
>() {}

export const TerraformLive = Layer.effect(
  Terraform,
  Effect.gen(function* () {
    const sub = yield* Subprocess
    return Terraform.of({
      version: sub
        .run("terraform", ["version", "-json"])
        .pipe(Effect.map((r) => r.stdout.trim())),
      destroy: ({ dir, vars }) =>
        Effect.gen(function* () {
          yield* sub.runInteractive(
            "terraform",
            ["init", "-input=false"],
            { cwd: dir },
          )
          const varArgs = Object.entries(vars ?? {}).flatMap(([k, v]) => [
            "-var",
            `${k}=${v}`,
          ])
          yield* sub.runInteractive(
            "terraform",
            ["destroy", "-auto-approve", "-input=false", ...varArgs],
            { cwd: dir },
          )
        }),
      apply: ({ dir, vars }) =>
        Effect.gen(function* () {
          yield* sub.runInteractive(
            "terraform",
            ["init", "-input=false"],
            { cwd: dir },
          )
          const varArgs = Object.entries(vars ?? {}).flatMap(([k, v]) => [
            "-var",
            `${k}=${v}`,
          ])
          yield* sub.runInteractive(
            "terraform",
            ["apply", "-auto-approve", "-input=false", ...varArgs],
            { cwd: dir },
          )
        }),
    })
  }),
)
