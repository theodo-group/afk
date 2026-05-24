import { Context, Effect, Layer } from "effect"
import { Subprocess } from "../../infra/Subprocess.ts"
import { AwsError } from "../../infra/Errors.ts"
import { awsError, makeAwsCli } from "./awsCli.ts"

export interface LogEvent {
  readonly timestamp: number
  readonly message: string
}

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
    const aws = makeAwsCli(sub)

    return Logs.of({
      ensureLogGroup: (region, name, retentionDays) =>
        Effect.gen(function* () {
          const exists = yield* aws
            .json<{ logGroups: ReadonlyArray<{ logGroupName: string }> }>(
              "logs:DescribeLogGroups",
              [
                "logs",
                "describe-log-groups",
                "--region",
                region,
                "--log-group-name-prefix",
                name,
              ],
            )
            .pipe(
              Effect.map((r) =>
                r.logGroups.some((g) => g.logGroupName === name),
              ),
            )
          if (!exists) {
            yield* aws.run("logs:CreateLogGroup", [
              "logs",
              "create-log-group",
              "--region",
              region,
              "--log-group-name",
              name,
            ])
          }
          yield* aws.run("logs:PutRetentionPolicy", [
            "logs",
            "put-retention-policy",
            "--region",
            region,
            "--log-group-name",
            name,
            "--retention-in-days",
            String(retentionDays),
          ])
        }),
      getEvents: (input) =>
        aws
          .json<{
            events: ReadonlyArray<{ timestamp: number; message: string }>
            nextForwardToken?: string
          }>("logs:GetLogEvents", [
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
          ])
          .pipe(
            Effect.map((r) => ({
              events: r.events.map<LogEvent>((e) => ({
                timestamp: e.timestamp,
                message: e.message,
              })),
              nextToken: r.nextForwardToken,
            })),
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
