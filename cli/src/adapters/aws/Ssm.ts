import { Context, Effect, Layer } from "effect"
import { Subprocess } from "../../infra/Subprocess.ts"
import { AwsError } from "../../infra/Errors.ts"

export interface SsmParameter {
  readonly name: string
  readonly lastModifiedDate?: string
}

const awsError = (op: string) => (e: { _tag: string; stderr?: string; cause?: unknown }) =>
  new AwsError({
    operation: op,
    message: e._tag === "ParseError" ? String(e.cause) : (e.stderr ?? ""),
  })

export class Ssm extends Context.Tag("Ssm")<
  Ssm,
  {
    readonly putSecret: (
      name: string,
      value: string,
    ) => Effect.Effect<void, AwsError>
    readonly deleteParameter: (name: string) => Effect.Effect<void, AwsError>
    readonly listByPrefix: (
      prefix: string,
    ) => Effect.Effect<ReadonlyArray<SsmParameter>, AwsError>
    readonly getParameterArn: (
      name: string,
      region: string,
      account: string,
    ) => string
  }
>() {}

export const SsmLive = Layer.effect(
  Ssm,
  Effect.gen(function* () {
    const sub = yield* Subprocess

    return Ssm.of({
      putSecret: (name, value) =>
        sub
          .run("aws", [
            "ssm",
            "put-parameter",
            "--name",
            name,
            "--value",
            value,
            "--type",
            "SecureString",
            "--overwrite",
            "--output",
            "json",
          ])
          .pipe(Effect.asVoid, Effect.mapError(awsError("ssm:PutParameter"))),
      deleteParameter: (name) =>
        sub
          .run("aws", [
            "ssm",
            "delete-parameter",
            "--name",
            name,
            "--output",
            "json",
          ])
          .pipe(
            Effect.asVoid,
            Effect.mapError(awsError("ssm:DeleteParameter")),
          ),
      listByPrefix: (prefix) =>
        sub
          .runJson<{
            Parameters: ReadonlyArray<{ Name: string; LastModifiedDate?: string }>
          }>("aws", [
            "ssm",
            "describe-parameters",
            "--parameter-filters",
            `Key=Name,Option=BeginsWith,Values=${prefix}`,
            "--output",
            "json",
          ])
          .pipe(
            Effect.map((r) =>
              r.Parameters.map<SsmParameter>((p) => ({
                name: p.Name,
                lastModifiedDate: p.LastModifiedDate,
              })),
            ),
            Effect.mapError(awsError("ssm:DescribeParameters")),
          ),
      getParameterArn: (name, region, account) =>
        `arn:aws:ssm:${region}:${account}:parameter${name.startsWith("/") ? name : `/${name}`}`,
    })
  }),
)
