import { Context, Effect, Layer } from "effect"
import { Subprocess } from "../infra/Subprocess.ts"
import { SubprocessError } from "../infra/Errors.ts"

export class Terraform extends Context.Tag("Terraform")<
  Terraform,
  {
    readonly version: Effect.Effect<string, SubprocessError>
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
    })
  }),
)
