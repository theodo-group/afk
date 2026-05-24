import { Context, Effect, Layer } from "effect"
import { Subprocess } from "../../infra/Subprocess.ts"
import { AwsError } from "../../infra/Errors.ts"
import { makeAwsCli } from "./awsCli.ts"

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
    const aws = makeAwsCli(sub)
    return Sts.of({
      callerIdentity: aws.json<CallerIdentity>("sts:GetCallerIdentity", [
        "sts",
        "get-caller-identity",
      ]),
    })
  }),
)
