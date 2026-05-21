import { Context, Effect, Layer } from "effect"
import { randomUUID } from "node:crypto"
import { Ecs, type Tag } from "../adapters/aws/Ecs.ts"
import { Sts } from "../adapters/aws/Sts.ts"
import { Ssm } from "../adapters/aws/Ssm.ts"
import { Logs } from "../adapters/aws/Logs.ts"
import { BuildService } from "./BuildService.ts"
import { ConfigService } from "./ConfigService.ts"
import { AwsError, UserError, DockerError, GitError, ConfigError } from "../infra/Errors.ts"
import {
  AFK_CLUSTER,
  AFK_SECURITY_GROUP,
  AFK_TASK_EXECUTION_ROLE,
  AFK_TASK_ROLE,
  DEFAULT_CPU,
  DEFAULT_MEMORY,
  DEFAULT_TIMEOUT_HOURS,
  LOG_GROUP_PREFIX,
  LOG_RETENTION_DAYS,
  TAG_BRANCH,
  TAG_MANAGED,
  TAG_OWNER,
  TAG_RUN_ID,
  TAG_SHA,
} from "../constants.ts"
import type { Run, RunStatus } from "../schema/Run.ts"

const mapStatus = (s: string): RunStatus =>
  ([
    "PROVISIONING",
    "PENDING",
    "RUNNING",
    "STOPPING",
    "STOPPED",
    "DEPROVISIONING",
  ] as const).includes(s as RunStatus)
    ? (s as RunStatus)
    : "STOPPED"

export interface RunInput {
  readonly command: ReadonlyArray<string>
  readonly ref?: string
  readonly cpu?: number
  readonly memory?: number
  readonly timeoutHours?: number
  readonly region: string
  readonly subnetIds: ReadonlyArray<string>
  readonly securityGroupIds: ReadonlyArray<string>
}

export interface RunStarted {
  readonly runId: string
  readonly taskArn: string
  readonly image: string
  readonly branch: string
  readonly sha: string
  readonly logGroup: string
  readonly logStream: string
}

export class RunService extends Context.Tag("RunService")<
  RunService,
  {
    readonly start: (
      input: RunInput,
    ) => Effect.Effect<
      RunStarted,
      AwsError | UserError | DockerError | GitError | ConfigError
    >
    readonly listMine: (
      currentArn: string,
    ) => Effect.Effect<ReadonlyArray<Run>, AwsError>
    readonly listAll: Effect.Effect<ReadonlyArray<Run>, AwsError>
    readonly findByRunId: (
      runId: string,
    ) => Effect.Effect<Run, AwsError | UserError>
    readonly kill: (runId: string) => Effect.Effect<void, AwsError | UserError>
    readonly attach: (
      runId: string,
    ) => Effect.Effect<void, AwsError | UserError>
  }
>() {}

const tagsToMap = (tags: ReadonlyArray<Tag>): Record<string, string> =>
  Object.fromEntries(tags.map((t) => [t.key, t.value]))

const ecsTaskToRun = (task: {
  taskArn: string
  lastStatus: string
  createdAt?: string
  stoppedAt?: string
  stoppedReason?: string
  tags: ReadonlyArray<Tag>
  cpu?: string
  memory?: string
  containers: ReadonlyArray<{ image?: string }>
}): Run | null => {
  const m = tagsToMap(task.tags)
  const runId = m[TAG_RUN_ID]
  const owner = m[TAG_OWNER]
  if (!runId || !owner) return null
  return {
    runId: runId as Run["runId"],
    taskArn: task.taskArn,
    status: mapStatus(task.lastStatus),
    owner,
    branch: m[TAG_BRANCH] ?? "",
    sha: m[TAG_SHA] ?? "",
    image: task.containers[0]?.image ?? "",
    cpu: Number(task.cpu ?? 0),
    memory: Number(task.memory ?? 0),
    startedAt: task.createdAt,
    stoppedAt: task.stoppedAt,
    stopReason: task.stoppedReason,
  }
}

const fetchAllRuns = (ecs: Context.Tag.Service<typeof Ecs>) =>
  Effect.gen(function* () {
    const [running, stopped] = yield* Effect.all([
      ecs.listTasks({ cluster: AFK_CLUSTER, desiredStatus: "RUNNING" }),
      ecs.listTasks({ cluster: AFK_CLUSTER, desiredStatus: "STOPPED" }),
    ])
    const arns = [...running, ...stopped]
    if (arns.length === 0) return []
    const tasks = yield* ecs.describeTasks({
      cluster: AFK_CLUSTER,
      taskArns: arns,
    })
    return tasks
      .map(ecsTaskToRun)
      .filter((r): r is Run => r !== null)
  })

const renderUserId = (arn: string) => arn

export const RunServiceLive = Layer.effect(
  RunService,
  Effect.gen(function* () {
    const ecs = yield* Ecs
    const sts = yield* Sts
    const ssm = yield* Ssm
    const logs = yield* Logs
    const build = yield* BuildService
    const cfg = yield* ConfigService

    const listAll = fetchAllRuns(ecs)
    const listMine = (currentArn: string) =>
      listAll.pipe(
        Effect.map((rs) => rs.filter((r) => r.owner === currentArn)),
      )

    const findByRunId = (runId: string) =>
      Effect.gen(function* () {
        const all = yield* listAll
        const found = all.find((r) => r.runId === runId)
        if (!found) {
          return yield* Effect.fail(
            new UserError({
              message: `Run ${runId} not found.`,
              hint: "Use `afk ls` to see available Runs.",
            }),
          )
        }
        return found
      })

    return RunService.of({
      listAll,
      listMine,
      findByRunId,

      start: (input) =>
        Effect.gen(function* () {
          const { config, envEntries, sourceRepoName } = yield* cfg.load
          const identity = yield* sts.callerIdentity

          const built = yield* build.build({ region: input.region, ref: input.ref })

          // Resource sizing
          const cpu = input.cpu ?? config.defaultCpu ?? DEFAULT_CPU
          const memory =
            input.memory ?? config.defaultMemory ?? DEFAULT_MEMORY
          const timeoutHours =
            input.timeoutHours ??
            config.defaultTimeoutHours ??
            DEFAULT_TIMEOUT_HOURS

          // Log group
          const logGroup = `${LOG_GROUP_PREFIX}/${sourceRepoName}`
          yield* logs.ensureLogGroup(logGroup, LOG_RETENTION_DAYS)

          const runId = randomUUID()
          const logStreamPrefix = "run"
          // ECS awslogs driver builds stream as `${prefix}/${containerName}/${taskId}`.
          // We don't know the taskId until RunTask returns; record the prefix instead.
          const logStream = `${logStreamPrefix}/run`

          // Env + secrets
          const environment = envEntries
            .filter((e) => e.kind === "plain")
            .map((e) => ({ name: e.name, value: (e as { value: string }).value }))
          environment.push({ name: "AFK_GIT_URL", value: config.gitUrl })
          environment.push({ name: "AFK_GIT_SHA", value: built.sha })
          environment.push({ name: "AFK_GIT_REF", value: input.ref ?? built.branch })
          environment.push({ name: "AFK_RUN_ID", value: runId })
          environment.push({
            name: "AFK_TIMEOUT_SECONDS",
            value: String(Math.floor(timeoutHours * 3600)),
          })

          const secrets = envEntries
            .filter((e) => e.kind === "ssm")
            .map((e) => ({
              name: e.name,
              valueFrom: ssm.getParameterArn(
                (e as { ssmName: string }).ssmName,
                input.region,
                identity.Account,
              ),
            }))

          const family = `afk-${sourceRepoName}`.replace(/[^a-zA-Z0-9-]/g, "-")
          const executionRoleArn = `arn:aws:iam::${identity.Account}:role/${AFK_TASK_EXECUTION_ROLE}`
          const taskRoleArn = `arn:aws:iam::${identity.Account}:role/${AFK_TASK_ROLE}`

          const td = yield* ecs.registerTaskDefinition({
            family,
            cpu: String(cpu),
            memory: String(memory),
            executionRoleArn,
            taskRoleArn,
            image: built.image,
            command: [...input.command],
            environment,
            secrets,
            logGroup,
            logRegion: input.region,
            logStreamPrefix,
          })

          const task = yield* ecs.runTask({
            cluster: AFK_CLUSTER,
            taskDefinitionArn: td.taskDefinitionArn,
            subnets: input.subnetIds,
            securityGroups: input.securityGroupIds,
            assignPublicIp: true,
            enableExecuteCommand: true,
            tags: [
              { key: TAG_OWNER, value: renderUserId(identity.Arn) },
              { key: TAG_RUN_ID, value: runId },
              { key: TAG_BRANCH, value: built.branch },
              { key: TAG_SHA, value: built.sha },
              { key: TAG_MANAGED, value: "true" },
            ],
          })

          return {
            runId,
            taskArn: task.taskArn,
            image: built.image,
            branch: built.branch,
            sha: built.sha,
            logGroup,
            logStream,
          }
        }),

      kill: (runId) =>
        Effect.gen(function* () {
          const run = yield* findByRunId(runId)
          yield* ecs.stopTask({
            cluster: AFK_CLUSTER,
            taskArn: run.taskArn,
            reason: `killed by afk cli`,
          })
        }),

      attach: (runId) =>
        Effect.gen(function* () {
          const run = yield* findByRunId(runId)
          if (run.status !== "RUNNING") {
            return yield* Effect.fail(
              new UserError({
                message: `Run ${runId} is not RUNNING (status: ${run.status}).`,
              }),
            )
          }
          yield* ecs.executeCommand({
            cluster: AFK_CLUSTER,
            taskArn: run.taskArn,
            command: "/bin/sh",
          })
        }),
    })
  }),
)
