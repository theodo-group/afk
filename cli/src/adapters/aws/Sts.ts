import { Context, Effect, Layer } from "effect"
import { Subprocess } from "../../infra/Subprocess.ts"
import { AwsError } from "../../infra/Errors.ts"

export interface CallerIdentity {
  readonly Account: string
  readonly Arn: string
  readonly UserId: string
}

export class Sts extends Context.Tag("Sts")<
  Sts,
  {
    readonly callerIdentity: Effect.Effect<CallerIdentity, AwsError>
  }
>() {}

export const StsLive = Layer.effect(
  Sts,
  Effect.gen(function* () {
    const sub = yield* Subprocess
    return Sts.of({
      callerIdentity: sub
        .runJson<CallerIdentity>("aws", [
          "sts",
          "get-caller-identity",
          "--output",
          "json",
        ])
        .pipe(
          Effect.mapError((e) =>
            e._tag === "ParseError"
              ? new AwsError({
                  operation: "sts:GetCallerIdentity",
                  message: String(e.cause),
                })
              : new AwsError({
                  operation: "sts:GetCallerIdentity",
                  message: e.stderr,
                }),
          ),
        ),
    })
  }),
)
