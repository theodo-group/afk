import { Context, Effect, Layer } from "effect"
import { Subprocess } from "../../infra/Subprocess.ts"
import { AwsError } from "../../infra/Errors.ts"
import { awsError, makeAwsCli } from "./awsCli.ts"

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

    /**
     * Wait until the instance's SSM agent is registered and Online — needed
     * after resuming a stopped instance, before the agent can accept a session.
     */
    readonly waitForAgent: (input: {
      readonly region: string
      readonly instanceId: string
      readonly pollIntervalMs?: number
      readonly maxWaitMs?: number
    }) => Effect.Effect<void, AwsError>
  }
>() {}

const sleep = (ms: number) =>
  Effect.promise(() => new Promise((r) => setTimeout(r, ms)))

export const SsmLive = Layer.effect(
  Ssm,
  Effect.gen(function* () {
    const sub = yield* Subprocess
    const aws = makeAwsCli(sub)

    const sendShellCommand = (input: {
      readonly region: string
      readonly instanceId: string
      readonly commands: ReadonlyArray<string>
      readonly timeoutSeconds?: number
    }) =>
      aws
        .json<{ Command: { CommandId: string } }>("ssm:SendCommand", [
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
        ])
        .pipe(Effect.map((r) => ({ commandId: r.Command.CommandId })))

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
        // biome-ignore lint/plugin/noloops: deadline-bounded poll of SSM — each pass depends on the previous invocation result (code-style.md exception)
        while (true) {
          const r = yield* aws
            .json<{
              Status: string
              StandardOutputContent?: string
              StandardErrorContent?: string
            }>("ssm:GetCommandInvocation", [
              "ssm",
              "get-command-invocation",
              "--region",
              input.region,
              "--command-id",
              input.commandId,
              "--instance-id",
              input.instanceId,
            ])
            .pipe(
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

    const waitForAgent = (input: {
      readonly region: string
      readonly instanceId: string
      readonly pollIntervalMs?: number
      readonly maxWaitMs?: number
    }) =>
      Effect.gen(function* () {
        const pollMs = input.pollIntervalMs ?? 3000
        const maxMs = input.maxWaitMs ?? 3 * 60 * 1000
        const deadline = Date.now() + maxMs
        // biome-ignore lint/plugin/noloops: deadline-bounded poll of SSM agent registration — each pass depends on the previous ping status (code-style.md exception)
        while (true) {
          const online = yield* aws
            .json<{
              InstanceInformationList: ReadonlyArray<{ PingStatus?: string }>
            }>("ssm:DescribeInstanceInformation", [
              "ssm",
              "describe-instance-information",
              "--region",
              input.region,
              "--filters",
              `Key=InstanceIds,Values=${input.instanceId}`,
            ])
            .pipe(
              Effect.map(
                (r) => r.InstanceInformationList[0]?.PingStatus === "Online",
              ),
              Effect.catchAll(() => Effect.succeed(false)),
            )
          if (online) return
          if (Date.now() > deadline) {
            return yield* Effect.fail(
              new AwsError({
                operation: "ssm:DescribeInstanceInformation",
                message: `SSM agent on ${input.instanceId} did not come Online within ${Math.floor(maxMs / 1000)}s`,
              }),
            )
          }
          yield* sleep(pollMs)
        }
      })

    return Ssm.of({
      putSecret: (region, name, value) =>
        aws.run("ssm:PutParameter", [
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
        ]),
      deleteParameter: (region, name) =>
        aws.run("ssm:DeleteParameter", [
          "ssm",
          "delete-parameter",
          "--region",
          region,
          "--name",
          name,
        ]),
      listByPrefix: (region, prefix) =>
        aws
          .json<{
            Parameters: ReadonlyArray<{
              Name: string
              LastModifiedDate?: string
            }>
          }>("ssm:DescribeParameters", [
            "ssm",
            "describe-parameters",
            "--region",
            region,
            "--parameter-filters",
            `Key=Name,Option=BeginsWith,Values=${prefix}`,
          ])
          .pipe(
            Effect.map((r) =>
              r.Parameters.map<SsmParameter>((p) => ({
                name: p.Name,
                lastModifiedDate: p.LastModifiedDate,
              })),
            ),
          ),
      getParameterArn: (name, region, account) =>
        `arn:aws:ssm:${region}:${account}:parameter${name.startsWith("/") ? name : `/${name}`}`,

      sendShellCommand,
      waitForCommand,
      waitForAgent,

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
