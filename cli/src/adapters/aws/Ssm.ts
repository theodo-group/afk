import { Context, Effect, Layer } from "effect"
import { Subprocess } from "../../infra/Subprocess.ts"
import { AwsError } from "../../infra/Errors.ts"

export interface SsmParameter {
  readonly name: string
  readonly lastModifiedDate?: string
}

export interface SendCommandResult {
  readonly commandId: string
}

export interface CommandInvocation {
  readonly status: string // Pending | InProgress | Success | Failed | Cancelled | TimedOut
  readonly stdout: string
  readonly stderr: string
}

const awsError =
  (op: string) => (e: { _tag: string; stderr?: string; cause?: unknown }) =>
    new AwsError({
      operation: op,
      message: e._tag === "ParseError" ? String(e.cause) : (e.stderr ?? ""),
    })

export class Ssm extends Context.Tag("Ssm")<
  Ssm,
  {
    readonly putSecret: (
      region: string,
      name: string,
      value: string,
    ) => Effect.Effect<void, AwsError>
    readonly deleteParameter: (
      region: string,
      name: string,
    ) => Effect.Effect<void, AwsError>
    readonly listByPrefix: (
      region: string,
      prefix: string,
    ) => Effect.Effect<ReadonlyArray<SsmParameter>, AwsError>
    readonly getParameterArn: (
      name: string,
      region: string,
      account: string,
    ) => string

    readonly sendShellCommand: (input: {
      readonly region: string
      readonly instanceId: string
      readonly commands: ReadonlyArray<string>
      readonly timeoutSeconds?: number
    }) => Effect.Effect<SendCommandResult, AwsError>

    readonly waitForCommand: (input: {
      readonly region: string
      readonly commandId: string
      readonly instanceId: string
      readonly pollIntervalMs?: number
      readonly maxWaitMs?: number
    }) => Effect.Effect<CommandInvocation, AwsError>

    /**
     * Start an interactive SSM session that immediately runs `command` against
     * the target instance (StartInteractiveCommand document). Streams to the
     * caller's TTY.
     */
    readonly startInteractiveCommand: (input: {
      readonly region: string
      readonly instanceId: string
      readonly command: string
    }) => Effect.Effect<void, AwsError>

    /**
     * Open a plain interactive shell on the target host (SessionManagerRunShell).
     */
    readonly startHostShell: (input: {
      readonly region: string
      readonly instanceId: string
    }) => Effect.Effect<void, AwsError>
  }
>() {}

const sleep = (ms: number) =>
  Effect.promise(() => new Promise((r) => setTimeout(r, ms)))

export const SsmLive = Layer.effect(
  Ssm,
  Effect.gen(function* () {
    const sub = yield* Subprocess

    const sendShellCommand = (input: {
      readonly region: string
      readonly instanceId: string
      readonly commands: ReadonlyArray<string>
      readonly timeoutSeconds?: number
    }) =>
      sub
        .runJson<{ Command: { CommandId: string } }>("aws", [
          "ssm",
          "send-command",
          "--region",
          input.region,
          "--instance-ids",
          input.instanceId,
          "--document-name",
          "AWS-RunShellScript",
          "--parameters",
          JSON.stringify({ commands: input.commands }),
          "--timeout-seconds",
          String(input.timeoutSeconds ?? 1800),
          "--output",
          "json",
        ])
        .pipe(
          Effect.map((r) => ({ commandId: r.Command.CommandId })),
          Effect.mapError(awsError("ssm:SendCommand")),
        )

    const waitForCommand = (input: {
      readonly region: string
      readonly commandId: string
      readonly instanceId: string
      readonly pollIntervalMs?: number
      readonly maxWaitMs?: number
    }) =>
      Effect.gen(function* () {
        const pollMs = input.pollIntervalMs ?? 3000
        const maxMs = input.maxWaitMs ?? 30 * 60 * 1000
        const deadline = Date.now() + maxMs
        while (true) {
          const r = yield* sub
            .runJson<{
              Status: string
              StandardOutputContent?: string
              StandardErrorContent?: string
            }>("aws", [
              "ssm",
              "get-command-invocation",
              "--region",
              input.region,
              "--command-id",
              input.commandId,
              "--instance-id",
              input.instanceId,
              "--output",
              "json",
            ])
            .pipe(
              Effect.mapError(awsError("ssm:GetCommandInvocation")),
              // get-command-invocation 404s briefly after send-command; retry
              Effect.catchAll(() =>
                Effect.succeed({
                  Status: "Pending",
                  StandardOutputContent: "",
                  StandardErrorContent: "",
                } as const),
              ),
            )
          if (
            r.Status === "Success" ||
            r.Status === "Failed" ||
            r.Status === "Cancelled" ||
            r.Status === "TimedOut"
          ) {
            return {
              status: r.Status,
              stdout: r.StandardOutputContent ?? "",
              stderr: r.StandardErrorContent ?? "",
            }
          }
          if (Date.now() > deadline) {
            return yield* Effect.fail(
              new AwsError({
                operation: "ssm:GetCommandInvocation",
                message: `command ${input.commandId} did not complete within ${Math.floor(maxMs / 1000)}s (last status: ${r.Status})`,
              }),
            )
          }
          yield* sleep(pollMs)
        }
      })

    return Ssm.of({
      putSecret: (region, name, value) =>
        sub
          .run("aws", [
            "ssm",
            "put-parameter",
            "--region",
            region,
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
      deleteParameter: (region, name) =>
        sub
          .run("aws", [
            "ssm",
            "delete-parameter",
            "--region",
            region,
            "--name",
            name,
            "--output",
            "json",
          ])
          .pipe(
            Effect.asVoid,
            Effect.mapError(awsError("ssm:DeleteParameter")),
          ),
      listByPrefix: (region, prefix) =>
        sub
          .runJson<{
            Parameters: ReadonlyArray<{
              Name: string
              LastModifiedDate?: string
            }>
          }>("aws", [
            "ssm",
            "describe-parameters",
            "--region",
            region,
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

      sendShellCommand,
      waitForCommand,

      startInteractiveCommand: (input) =>
        sub
          .runInteractive("aws", [
            "ssm",
            "start-session",
            "--region",
            input.region,
            "--target",
            input.instanceId,
            "--document-name",
            "AWS-StartInteractiveCommand",
            "--parameters",
            JSON.stringify({ command: [input.command] }),
          ])
          .pipe(
            Effect.mapError(awsError("ssm:StartSession (interactive command)")),
          ),

      startHostShell: (input) =>
        sub
          .runInteractive("aws", [
            "ssm",
            "start-session",
            "--region",
            input.region,
            "--target",
            input.instanceId,
          ])
          .pipe(Effect.mapError(awsError("ssm:StartSession"))),
    })
  }),
)
