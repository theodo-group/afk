import { Context, Effect, Layer } from "effect"
import { Subprocess } from "../../infra/Subprocess.ts"
import { AwsError } from "../../infra/Errors.ts"

export interface Tag {
  readonly key: string
  readonly value: string
}

export interface KeyValuePair {
  readonly name: string
  readonly value: string
}

export interface SecretRef {
  readonly name: string
  readonly valueFrom: string
}

export interface RegisterTaskDefinitionInput {
  readonly family: string
  readonly cpu: string
  readonly memory: string
  readonly executionRoleArn: string
  readonly taskRoleArn: string
  readonly image: string
  readonly command: ReadonlyArray<string>
  readonly environment: ReadonlyArray<KeyValuePair>
  readonly secrets: ReadonlyArray<SecretRef>
  readonly logGroup: string
  readonly logRegion: string
  readonly logStreamPrefix: string
}

export interface RunTaskInput {
  readonly cluster: string
  readonly taskDefinitionArn: string
  readonly subnets: ReadonlyArray<string>
  readonly securityGroups: ReadonlyArray<string>
  readonly assignPublicIp: boolean
  readonly enableExecuteCommand: boolean
  readonly tags: ReadonlyArray<Tag>
}

export interface EcsTask {
  readonly taskArn: string
  readonly lastStatus: string
  readonly desiredStatus: string
  readonly createdAt?: string
  readonly stoppedAt?: string
  readonly stoppedReason?: string
  readonly tags: ReadonlyArray<Tag>
  readonly cpu?: string
  readonly memory?: string
  readonly containers: ReadonlyArray<{
    readonly image?: string
    readonly lastStatus?: string
  }>
}

export class Ecs extends Context.Tag("Ecs")<
  Ecs,
  {
    readonly registerTaskDefinition: (
      input: RegisterTaskDefinitionInput,
    ) => Effect.Effect<{ readonly taskDefinitionArn: string }, AwsError>
    readonly deregisterTaskDefinition: (
      arn: string,
    ) => Effect.Effect<void, AwsError>
    readonly runTask: (
      input: RunTaskInput,
    ) => Effect.Effect<{ readonly taskArn: string }, AwsError>
    readonly listTasks: (input: {
      readonly cluster: string
      readonly desiredStatus?: "RUNNING" | "STOPPED"
    }) => Effect.Effect<ReadonlyArray<string>, AwsError>
    readonly describeTasks: (input: {
      readonly cluster: string
      readonly taskArns: ReadonlyArray<string>
    }) => Effect.Effect<ReadonlyArray<EcsTask>, AwsError>
    readonly stopTask: (input: {
      readonly cluster: string
      readonly taskArn: string
      readonly reason: string
    }) => Effect.Effect<void, AwsError>
    readonly executeCommand: (input: {
      readonly cluster: string
      readonly taskArn: string
      readonly command: string
    }) => Effect.Effect<void, AwsError>
  }
>() {}

const awsError = (op: string) => (e: { _tag: string; stderr?: string; cause?: unknown }) =>
  new AwsError({
    operation: op,
    message: e._tag === "ParseError" ? String(e.cause) : (e.stderr ?? ""),
  })

export const EcsLive = Layer.effect(
  Ecs,
  Effect.gen(function* () {
    const sub = yield* Subprocess

    const registerTaskDefinition = (input: RegisterTaskDefinitionInput) => {
      const def = {
        family: input.family,
        networkMode: "awsvpc",
        requiresCompatibilities: ["FARGATE"],
        cpu: input.cpu,
        memory: input.memory,
        executionRoleArn: input.executionRoleArn,
        taskRoleArn: input.taskRoleArn,
        containerDefinitions: [
          {
            name: "run",
            image: input.image,
            essential: true,
            command: input.command,
            environment: input.environment.map((e) => ({
              name: e.name,
              value: e.value,
            })),
            secrets: input.secrets.map((s) => ({
              name: s.name,
              valueFrom: s.valueFrom,
            })),
            logConfiguration: {
              logDriver: "awslogs",
              options: {
                "awslogs-group": input.logGroup,
                "awslogs-region": input.logRegion,
                "awslogs-stream-prefix": input.logStreamPrefix,
                "awslogs-create-group": "true",
              },
            },
            linuxParameters: { initProcessEnabled: true },
          },
        ],
      }
      return sub
        .runJson<{ taskDefinition: { taskDefinitionArn: string } }>(
          "aws",
          [
            "ecs",
            "register-task-definition",
            "--cli-input-json",
            JSON.stringify(def),
            "--output",
            "json",
          ],
        )
        .pipe(
          Effect.map((r) => ({
            taskDefinitionArn: r.taskDefinition.taskDefinitionArn,
          })),
          Effect.mapError(awsError("ecs:RegisterTaskDefinition")),
        )
    }

    return Ecs.of({
      registerTaskDefinition,
      deregisterTaskDefinition: (arn) =>
        sub
          .run("aws", [
            "ecs",
            "deregister-task-definition",
            "--task-definition",
            arn,
            "--output",
            "json",
          ])
          .pipe(
            Effect.asVoid,
            Effect.mapError(awsError("ecs:DeregisterTaskDefinition")),
          ),
      runTask: (input) => {
        const networkConfig = {
          awsvpcConfiguration: {
            subnets: input.subnets,
            securityGroups: input.securityGroups,
            assignPublicIp: input.assignPublicIp ? "ENABLED" : "DISABLED",
          },
        }
        return sub
          .runJson<{ tasks: ReadonlyArray<{ taskArn: string }> }>("aws", [
            "ecs",
            "run-task",
            "--cluster",
            input.cluster,
            "--task-definition",
            input.taskDefinitionArn,
            "--launch-type",
            "FARGATE",
            "--network-configuration",
            JSON.stringify(networkConfig),
            ...(input.enableExecuteCommand ? ["--enable-execute-command"] : []),
            "--tags",
            input.tags.map((t) => `key=${t.key},value=${t.value}`).join(" "),
            "--output",
            "json",
          ])
          .pipe(
            Effect.flatMap((r) => {
              const first = r.tasks[0]
              if (!first)
                return Effect.fail(
                  new AwsError({
                    operation: "ecs:RunTask",
                    message: "no task returned",
                  }),
                )
              return Effect.succeed({ taskArn: first.taskArn })
            }),
            Effect.mapError((e) =>
              e instanceof AwsError ? e : awsError("ecs:RunTask")(e),
            ),
          )
      },
      listTasks: (input) =>
        sub
          .runJson<{ taskArns: ReadonlyArray<string> }>("aws", [
            "ecs",
            "list-tasks",
            "--cluster",
            input.cluster,
            ...(input.desiredStatus
              ? ["--desired-status", input.desiredStatus]
              : []),
            "--output",
            "json",
          ])
          .pipe(
            Effect.map((r) => r.taskArns),
            Effect.mapError(awsError("ecs:ListTasks")),
          ),
      describeTasks: (input) =>
        input.taskArns.length === 0
          ? Effect.succeed([])
          : sub
              .runJson<{
                tasks: ReadonlyArray<{
                  taskArn: string
                  lastStatus: string
                  desiredStatus: string
                  createdAt?: string
                  stoppedAt?: string
                  stoppedReason?: string
                  tags?: ReadonlyArray<{ key: string; value: string }>
                  cpu?: string
                  memory?: string
                  containers?: ReadonlyArray<{
                    image?: string
                    lastStatus?: string
                  }>
                }>
              }>("aws", [
                "ecs",
                "describe-tasks",
                "--cluster",
                input.cluster,
                "--tasks",
                ...input.taskArns,
                "--include",
                "TAGS",
                "--output",
                "json",
              ])
              .pipe(
                Effect.map((r) =>
                  r.tasks.map<EcsTask>((t) => ({
                    taskArn: t.taskArn,
                    lastStatus: t.lastStatus,
                    desiredStatus: t.desiredStatus,
                    createdAt: t.createdAt,
                    stoppedAt: t.stoppedAt,
                    stoppedReason: t.stoppedReason,
                    tags: (t.tags ?? []).map((tag) => ({
                      key: tag.key,
                      value: tag.value,
                    })),
                    cpu: t.cpu,
                    memory: t.memory,
                    containers: (t.containers ?? []).map((c) => ({
                      image: c.image,
                      lastStatus: c.lastStatus,
                    })),
                  })),
                ),
                Effect.mapError(awsError("ecs:DescribeTasks")),
              ),
      stopTask: (input) =>
        sub
          .run("aws", [
            "ecs",
            "stop-task",
            "--cluster",
            input.cluster,
            "--task",
            input.taskArn,
            "--reason",
            input.reason,
            "--output",
            "json",
          ])
          .pipe(Effect.asVoid, Effect.mapError(awsError("ecs:StopTask"))),
      executeCommand: (input) =>
        sub
          .runInteractive("aws", [
            "ecs",
            "execute-command",
            "--cluster",
            input.cluster,
            "--task",
            input.taskArn,
            "--container",
            "run",
            "--interactive",
            "--command",
            input.command,
          ])
          .pipe(Effect.mapError(awsError("ecs:ExecuteCommand"))),
    })
  }),
)
