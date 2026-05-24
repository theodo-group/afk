import { Context, Effect, Layer } from "effect"
import { Subprocess } from "../../infra/Subprocess.ts"
import { AwsError } from "../../infra/Errors.ts"

export interface LogEvent {
  readonly timestamp: number
  readonly message: string
}

const awsError =
  (op: string) => (e: { _tag: string; stderr?: string; cause?: unknown }) =>
    new AwsError({
      operation: op,
      message: e._tag === "ParseError" ? String(e.cause) : (e.stderr ?? ""),
    })

export class Logs extends Context.Tag("Logs")<
  Logs,
  {
    readonly ensureLogGroup: (
      region: string,
      name: string,
      retentionDays: number,
    ) => Effect.Effect<void, AwsError>
    readonly getEvents: (input: {
      readonly region: string
      readonly group: string
      readonly stream: string
      readonly startFromHead?: boolean
      readonly nextToken?: string
    }) => Effect.Effect<
      { readonly events: ReadonlyArray<LogEvent>; readonly nextToken?: string },
      AwsError
    >
    readonly tail: (input: {
      readonly region: string
      readonly group: string
      readonly stream?: string
      readonly follow?: boolean
      readonly since?: string
    }) => Effect.Effect<void, AwsError>
  }
>() {}

export const LogsLive = Layer.effect(
  Logs,
  Effect.gen(function* () {
    const sub = yield* Subprocess

    return Logs.of({
      ensureLogGroup: (region, name, retentionDays) =>
        Effect.gen(function* () {
          const exists = yield* sub
            .runJson<{ logGroups: ReadonlyArray<{ logGroupName: string }> }>(
              "aws",
              [
                "logs",
                "describe-log-groups",
                "--region",
                region,
                "--log-group-name-prefix",
                name,
                "--output",
                "json",
              ],
            )
            .pipe(
              Effect.map((r) =>
                r.logGroups.some((g) => g.logGroupName === name),
              ),
              Effect.mapError(awsError("logs:DescribeLogGroups")),
            )
          if (!exists) {
            yield* sub
              .run("aws", [
                "logs",
                "create-log-group",
                "--region",
                region,
                "--log-group-name",
                name,
                "--output",
                "json",
              ])
              .pipe(Effect.mapError(awsError("logs:CreateLogGroup")))
          }
          yield* sub
            .run("aws", [
              "logs",
              "put-retention-policy",
              "--region",
              region,
              "--log-group-name",
              name,
              "--retention-in-days",
              String(retentionDays),
              "--output",
              "json",
            ])
            .pipe(
              Effect.asVoid,
              Effect.mapError(awsError("logs:PutRetentionPolicy")),
            )
        }),
      getEvents: (input) =>
        sub
          .runJson<{
            events: ReadonlyArray<{ timestamp: number; message: string }>
            nextForwardToken?: string
          }>("aws", [
            "logs",
            "get-log-events",
            "--region",
            input.region,
            "--log-group-name",
            input.group,
            "--log-stream-name",
            input.stream,
            ...(input.startFromHead ? ["--start-from-head"] : []),
            ...(input.nextToken ? ["--next-token", input.nextToken] : []),
            "--output",
            "json",
          ])
          .pipe(
            Effect.map((r) => ({
              events: r.events.map<LogEvent>((e) => ({
                timestamp: e.timestamp,
                message: e.message,
              })),
              nextToken: r.nextForwardToken,
            })),
            Effect.mapError(awsError("logs:GetLogEvents")),
          ),
      tail: (input) =>
        sub
          .stream("aws", [
            "logs",
            "tail",
            input.group,
            "--region",
            input.region,
            ...(input.follow ? ["--follow"] : []),
            "--since",
            input.since ?? "24h",
            ...(input.stream ? ["--log-stream-name-prefix", input.stream] : []),
          ])
          .pipe(Effect.mapError(awsError("logs:Tail"))),
    })
  }),
)
