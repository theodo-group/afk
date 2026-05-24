import { Effect, Layer } from "effect"
import { randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { Ec2, type Tag as Ec2Tag } from "../../adapters/aws/Ec2.ts"
import { Sts } from "../../adapters/aws/Sts.ts"
import { Ssm } from "../../adapters/aws/Ssm.ts"
import { Logs } from "../../adapters/aws/Logs.ts"
import { ConfigService } from "../../services/ConfigService.ts"
import { GoldenImageStore } from "../../services/backend/GoldenImage.ts"
import { RunHistory } from "../../services/backend/RunHistory.ts"
import {
  Compute,
  type AttachOptions,
  type PreparedRun,
  type RunStarted,
  type StartInput,
} from "../../services/backend/Compute.ts"
import {
  AwsError,
  ConfigError,
  UserError,
} from "../../infra/Errors.ts"
import {
  AFK_SECURITY_GROUP,
  AFK_VM_INSTANCE_PROFILE,
  AFK_VPC_NAME,
  COMPOSE_FILE,
  DEFAULT_INSTANCE_TYPE,
  DEFAULT_MAIN_SERVICE,
  DEFAULT_REGION,
  LOG_GROUP_PREFIX,
  LOG_RETENTION_DAYS,
  TAG_BRANCH,
  TAG_MANAGED,
  TAG_OWNER,
  TAG_REPO,
  TAG_RUN_ID,
  TAG_SHA,
  TAG_STARTED_AT,
  TAG_TIMEOUT_HOURS,
  VM_AFK_DIR,
  VM_COMPOSE_PATH,
} from "../../constants.ts"
import type { Run, RunStatus } from "../../schema/Run.ts"
import { buildUserData } from "../../services/UserData.ts"
import { assembleRunPlan } from "../../services/RunPlan.ts"

const mapEc2State = (s: string): RunStatus => {
  switch (s) {
    case "pending":
      return "PROVISIONING"
    case "running":
      return "RUNNING"
    case "shutting-down":
    case "stopping":
      return "STOPPING"
    case "stopped":
    case "terminated":
    default:
      return "STOPPED"
  }
}

const tagsToMap = (tags: ReadonlyArray<Ec2Tag>): Record<string, string> =>
  Object.fromEntries(tags.map((t) => [t.key, t.value]))

const ec2InstanceToRun = (i: {
  instanceId: string
  state: string
  instanceType: string
  launchTime?: string
  imageId: string
  spotInstanceRequestId?: string
  stateReason?: string
  tags: ReadonlyArray<Ec2Tag>
}): Run | null => {
  const m = tagsToMap(i.tags)
  const runId = m[TAG_RUN_ID]
  const owner = m[TAG_OWNER]
  if (!runId || !owner) return null
  const spot = Boolean(i.spotInstanceRequestId)
  return {
    runId: runId as Run["runId"],
    resourceId: i.instanceId,
    status: mapEc2State(i.state),
    backend: "aws",
    owner,
    branch: m[TAG_BRANCH] ?? "",
    sha: m[TAG_SHA] ?? "",
    image: i.imageId,
    backendDetails: {
      instanceType: i.instanceType,
      spot: String(spot),
    },
    startedAt: m[TAG_STARTED_AT] ?? i.launchTime,
    stoppedAt: undefined,
    stopReason: i.stateReason,
  }
}

interface AwsBackendPlan {
  readonly region: string
  readonly accountId: string
  readonly amiId: string
  readonly instanceType: string
  readonly spot: boolean
  readonly subnetIds: ReadonlyArray<string>
  readonly securityGroupId: string
  readonly tags: ReadonlyArray<Ec2Tag>
  readonly userData: string
  readonly imageWasSkipped: boolean
  readonly startedAt: string
}

export const AwsComputeLive = Layer.effect(
  Compute,
  Effect.gen(function* () {
    const ec2 = yield* Ec2
    const sts = yield* Sts
    const ssm = yield* Ssm
    const logs = yield* Logs
    const cfg = yield* ConfigService
    const golden = yield* GoldenImageStore
    const history = yield* RunHistory

    const resolveRegion = cfg.load.pipe(
      Effect.map((r) => r.config.aws?.region ?? DEFAULT_REGION),
    )

    const fetchRunsAtRegion = (region: string, ownerUserId?: string) =>
      Effect.gen(function* () {
        const tagFilters = [
          { key: TAG_MANAGED, values: ["true"] },
          ...(ownerUserId ? [{ key: TAG_OWNER, values: [ownerUserId] }] : []),
        ]
        const instances = yield* ec2.describeInstances({
          region,
          tagFilters,
          states: [
            "pending",
            "running",
            "shutting-down",
            "stopping",
            "stopped",
            "terminated",
          ],
        })
        return instances
          .map(ec2InstanceToRun)
          .filter((r): r is Run => r !== null)
      })

    const listAll = Effect.gen(function* () {
      const region = yield* resolveRegion
      return yield* fetchRunsAtRegion(region)
    })

    const listMine = (ownerUserId: string) =>
      Effect.gen(function* () {
        const region = yield* resolveRegion
        return yield* fetchRunsAtRegion(region, ownerUserId)
      })

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

    const prepare = (input: StartInput) =>
      Effect.gen(function* () {
        const { config, envEntries, projectRoot, sourceRepoName } = yield* cfg.load
        const identity = yield* sts.callerIdentity
        const region = config.aws?.region ?? DEFAULT_REGION

        const latestGolden = yield* golden.findLatest
        if (!latestGolden) {
          return yield* Effect.fail(
            new UserError({
              message: `No Golden Image found in ${region}.`,
              hint: "Run `afk golden build` to create one.",
            }),
          )
        }

        const instanceTypeOverride =
          typeof input.backendOverrides?.instanceType === "string"
            ? input.backendOverrides.instanceType
            : undefined
        const instanceType =
          instanceTypeOverride ??
          config.aws?.defaultInstanceType ??
          config.defaultInstanceType ??
          DEFAULT_INSTANCE_TYPE
        const whitelist =
          config.aws?.allowedInstanceTypes ?? config.allowedInstanceTypes
        if (whitelist && whitelist.length > 0 && !whitelist.includes(instanceType)) {
          return yield* Effect.fail(
            new UserError({
              message: `Instance type '${instanceType}' is not in allowedInstanceTypes.`,
              hint: `Pick one of: ${whitelist.join(", ")}`,
            }),
          )
        }

        // The orchestrator (RunService) has already done the image build.
        const built = input.built
        const mainService = config.mainService ?? DEFAULT_MAIN_SERVICE

        const composePath = resolve(projectRoot, COMPOSE_FILE)
        const composeRaw = existsSync(composePath)
          ? yield* Effect.try({
              try: () => readFileSync(composePath, "utf8"),
              catch: (cause) =>
                new ConfigError({
                  path: composePath,
                  message: `cannot read: ${String(cause)}`,
                }),
            })
          : undefined

        const runId = randomUUID()
        const startedAt = new Date().toISOString()

        const assembled = assembleRunPlan({
          config,
          envEntries,
          built,
          ref: input.ref,
          timeoutHours: input.timeoutHours,
          mainService,
          backend: "aws",
          composeContent: composeRaw,
          runId,
        })
        if (assembled.composeError) {
          return yield* Effect.fail(new UserError({ message: assembled.composeError }))
        }
        for (const w of assembled.warnings) console.warn(`warning: ${w}`)
        const { timeoutHours, timeoutSeconds, env, secrets, composeContent, composeUsed } =
          assembled

        const logGroup = `${LOG_GROUP_PREFIX}/${sourceRepoName}`
        yield* logs.ensureLogGroup(region, logGroup, LOG_RETENTION_DAYS)

        const vpcId = yield* ec2.findVpcIdByName(region, AFK_VPC_NAME)
        const subnetIds = yield* ec2.findSubnetIdsByVpcId(region, vpcId)
        if (subnetIds.length === 0) {
          return yield* Effect.fail(
            new UserError({
              message: `No subnets found in VPC '${AFK_VPC_NAME}'.`,
              hint: "Apply the AFK Terraform first.",
            }),
          )
        }
        const sgId = yield* ec2.findSecurityGroupIdByName(
          region,
          vpcId,
          AFK_SECURITY_GROUP,
        )

        const userData = buildUserData({
          runId,
          region,
          accountId: identity.Account,
          repoName: sourceRepoName,
          mainService,
          image: built.image,
          command: input.command,
          timeoutSeconds,
          env,
          // UserData still expects {name, ssmName} for back-compat with the AWS
          // entrypoint which dereferences via the VM's instance profile.
          secrets: secrets.map((s) => ({
            name: s.name,
            ssmName: `/afk/secrets/${s.secretName}`,
          })),
          compose: composeContent,
        })

        const onDemandOverride =
          input.backendOverrides?.onDemand === true ||
          input.backendOverrides?.onDemand === "true"
        const spot = !onDemandOverride

        const tags: ReadonlyArray<Ec2Tag> = [
          { key: TAG_OWNER, value: identity.UserId },
          { key: TAG_RUN_ID, value: runId },
          { key: TAG_BRANCH, value: built.branch },
          { key: TAG_SHA, value: built.sha },
          { key: TAG_MANAGED, value: "true" },
          { key: TAG_REPO, value: sourceRepoName },
          { key: TAG_TIMEOUT_HOURS, value: String(timeoutHours) },
          { key: TAG_STARTED_AT, value: startedAt },
          { key: "Name", value: `afk-${sourceRepoName}-${runId.slice(0, 8)}` },
        ]

        const backendPlan: AwsBackendPlan = {
          region,
          accountId: identity.Account,
          amiId: latestGolden.id,
          instanceType,
          spot,
          subnetIds,
          securityGroupId: sgId,
          tags,
          userData,
          imageWasSkipped: built.skipped,
          startedAt,
        }

        const plan: PreparedRun = {
          runId,
          command: input.command,
          image: built.image,
          branch: built.branch,
          sha: built.sha,
          composeUsed,
          mainService,
          timeoutHours,
          timeoutSeconds,
          owner: identity.UserId,
          repoName: sourceRepoName,
          env,
          secrets,
          logChannel: logGroup,
          backendPlan: backendPlan as unknown as Record<string, unknown>,
        }
        return plan
      })

    const launch = (plan: PreparedRun) =>
      Effect.gen(function* () {
        const aws = plan.backendPlan as unknown as AwsBackendPlan

        const { instanceId } = yield* ec2.runInstance({
          region: aws.region,
          imageId: aws.amiId,
          instanceType: aws.instanceType,
          subnetId: aws.subnetIds[Math.floor(Math.random() * aws.subnetIds.length)]!,
          securityGroupIds: [aws.securityGroupId],
          iamInstanceProfileName: AFK_VM_INSTANCE_PROFILE,
          userData: aws.userData,
          spot: aws.spot,
          tags: aws.tags,
        })

        yield* history
          .recordStart({
            runId: plan.runId,
            owner: plan.owner,
            repo: plan.repoName,
            branch: plan.branch,
            sha: plan.sha,
            image: plan.image,
            resourceId: instanceId,
            startedAt: aws.startedAt,
            timeoutHours: plan.timeoutHours,
            backendDetails: {
              instanceType: aws.instanceType,
              spot: String(aws.spot),
            },
          })
          .pipe(
            Effect.catchAll((e) =>
              Effect.sync(() => {
                console.warn(
                  `warning: failed to record run in history table: ${(e as { message?: string }).message ?? String(e)}`,
                )
              }),
            ),
          )

        const result: RunStarted = {
          runId: plan.runId,
          resourceId: instanceId,
          image: plan.image,
          branch: plan.branch,
          sha: plan.sha,
          composeUsed: plan.composeUsed,
          backendDetails: {
            instanceType: aws.instanceType,
            spot: String(aws.spot),
            instanceId,
          },
          logChannel: plan.logChannel,
        }
        return result
      })

    const kill = (runId: string) =>
      Effect.gen(function* () {
        const run = yield* findByRunId(runId)
        const region = yield* resolveRegion
        yield* ec2.terminateInstances(region, [run.resourceId])
      })

    const attach = (runId: string, opts: AttachOptions) =>
      Effect.gen(function* () {
        const { config } = yield* cfg.load
        const run = yield* findByRunId(runId)
        if (run.status === "PROVISIONING") {
          return yield* Effect.fail(
            new UserError({
              message: `Run ${runId} is still PROVISIONING — wait a few seconds.`,
            }),
          )
        }
        const region = config.aws?.region ?? DEFAULT_REGION
        const mainService = config.mainService ?? DEFAULT_MAIN_SERVICE
        const service = opts.service ?? mainService

        if (opts.host) {
          yield* ssm.startHostShell({ region, instanceId: run.resourceId })
          return
        }

        const cmd = [
          "set -e",
          `cd ${VM_AFK_DIR}`,
          `if [ -f ${VM_COMPOSE_PATH} ]; then`,
          `  docker compose -f ${VM_COMPOSE_PATH} exec ${service} bash 2>/dev/null \\`,
          `    || docker compose -f ${VM_COMPOSE_PATH} exec ${service} sh`,
          `else`,
          `  docker exec -it agent bash 2>/dev/null || docker exec -it agent sh`,
          `fi`,
        ].join("; ")

        yield* ssm.startInteractiveCommand({
          region,
          instanceId: run.resourceId,
          command: cmd,
        })
      })

    const callerPrincipal = Effect.gen(function* () {
      const identity = yield* sts.callerIdentity
      return {
        id: identity.UserId,
        displayName: identity.Arn,
      }
    })

    return Compute.of({
      backendName: "aws",
      prepare,
      launch,
      listMine,
      listAll,
      findByRunId,
      kill,
      attach,
      callerPrincipal,
    })
  }),
)
