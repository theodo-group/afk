import { Context, Effect, Layer } from "effect"
import { randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { Ec2, type Tag as Ec2Tag } from "../adapters/aws/Ec2.ts"
import { Sts } from "../adapters/aws/Sts.ts"
import { Ssm } from "../adapters/aws/Ssm.ts"
import { Logs } from "../adapters/aws/Logs.ts"
import { BuildService } from "./BuildService.ts"
import { ConfigService } from "./ConfigService.ts"
import { ImageService } from "./ImageService.ts"
import { HistoryService } from "./HistoryService.ts"
import {
  AwsError,
  UserError,
  DockerError,
  GitError,
  ConfigError,
} from "../infra/Errors.ts"
import {
  AFK_SECURITY_GROUP,
  AFK_VM_INSTANCE_PROFILE,
  AFK_VPC_NAME,
  COMPOSE_FILE,
  DEFAULT_INSTANCE_TYPE,
  DEFAULT_MAIN_SERVICE,
  DEFAULT_REGION,
  DEFAULT_TIMEOUT_HOURS,
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
} from "../constants.ts"
import type { Run, RunStatus } from "../schema/Run.ts"
import { buildUserData } from "./UserData.ts"
import { lintCompose, substituteImage } from "./Compose.ts"

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

export interface RunInput {
  readonly command: ReadonlyArray<string>
  readonly ref?: string
  readonly instanceType?: string
  readonly onDemand?: boolean
  readonly timeoutHours?: number
}

export interface RunStarted {
  readonly runId: string
  readonly instanceId: string
  readonly image: string
  readonly branch: string
  readonly sha: string
  readonly logGroup: string
  readonly instanceType: string
  readonly spot: boolean
  readonly composeUsed: boolean
}

/**
 * Resolved launch plan: everything the launcher needs to call ec2:RunInstances.
 * Produced by `RunService.prepare`; consumed by `RunService.launch`. Exposed
 * separately so `afk run --dry-run` can introspect what would happen without
 * launching anything.
 */
export interface RunPlan {
  readonly runId: string
  readonly region: string
  readonly accountId: string
  readonly repoName: string
  readonly mainService: string
  readonly amiId: string
  readonly instanceType: string
  readonly spot: boolean
  readonly timeoutHours: number
  readonly timeoutSeconds: number
  readonly subnetIds: ReadonlyArray<string>
  readonly securityGroupId: string
  readonly image: string
  readonly imageWasSkipped: boolean
  readonly branch: string
  readonly sha: string
  readonly composePresent: boolean
  readonly composeContent?: string
  readonly env: ReadonlyArray<{ readonly name: string; readonly value: string }>
  readonly secrets: ReadonlyArray<{ readonly name: string; readonly ssmName: string }>
  readonly tags: ReadonlyArray<Ec2Tag>
  readonly userData: string
  readonly logGroup: string
  readonly startedAt: string
  readonly owner: string
}

export interface AttachOptions {
  readonly service?: string
  readonly host?: boolean
}

export class RunService extends Context.Tag("RunService")<
  RunService,
  {
    /** Resolve everything needed to launch a Run, without launching. */
    readonly prepare: (
      input: RunInput,
    ) => Effect.Effect<
      RunPlan,
      AwsError | UserError | DockerError | GitError | ConfigError
    >
    /** Launch a previously-prepared plan. */
    readonly launch: (
      plan: RunPlan,
    ) => Effect.Effect<RunStarted, AwsError | UserError | ConfigError>
    /** Convenience: prepare + launch. */
    readonly start: (
      input: RunInput,
    ) => Effect.Effect<
      RunStarted,
      AwsError | UserError | DockerError | GitError | ConfigError
    >
    readonly listMine: (
      ownerUserId: string,
    ) => Effect.Effect<ReadonlyArray<Run>, AwsError | ConfigError | UserError>
    readonly listAll: Effect.Effect<ReadonlyArray<Run>, AwsError | ConfigError | UserError>
    readonly findByRunId: (
      runId: string,
    ) => Effect.Effect<Run, AwsError | UserError | ConfigError>
    readonly kill: (
      runId: string,
    ) => Effect.Effect<void, AwsError | UserError | ConfigError>
    readonly attach: (
      runId: string,
      opts: AttachOptions,
    ) => Effect.Effect<void, AwsError | UserError | ConfigError>
  }
>() {}

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
  return {
    runId: runId as Run["runId"],
    instanceId: i.instanceId,
    status: mapEc2State(i.state),
    owner,
    branch: m[TAG_BRANCH] ?? "",
    sha: m[TAG_SHA] ?? "",
    image: i.imageId,
    instanceType: i.instanceType,
    spot: Boolean(i.spotInstanceRequestId),
    startedAt: m[TAG_STARTED_AT] ?? i.launchTime,
    stoppedAt: undefined,
    stopReason: i.stateReason,
  }
}

export const RunServiceLive = Layer.effect(
  RunService,
  Effect.gen(function* () {
    const ec2 = yield* Ec2
    const sts = yield* Sts
    const ssm = yield* Ssm
    const logs = yield* Logs
    const build = yield* BuildService
    const cfg = yield* ConfigService
    const images = yield* ImageService
    const history = yield* HistoryService

    const resolveRegion = (regionOverride?: string) =>
      cfg.load.pipe(
        Effect.map((r) => regionOverride ?? r.config.aws?.region ?? DEFAULT_REGION),
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
      const region = yield* resolveRegion()
      return yield* fetchRunsAtRegion(region)
    })

    const listMine = (ownerUserId: string) =>
      Effect.gen(function* () {
        const region = yield* resolveRegion()
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

    const prepare = (input: RunInput) =>
      Effect.gen(function* () {
        const { config, envEntries, projectRoot, sourceRepoName } = yield* cfg.load
        const identity = yield* sts.callerIdentity
        const region = config.aws?.region ?? DEFAULT_REGION

        // Refuse if no golden AMI exists.
        const golden = yield* images.findLatestGolden(region)
        if (!golden) {
          return yield* Effect.fail(
            new UserError({
              message: `No Golden Image found in ${region}.`,
              hint: "Run `afk image build` to create one.",
            }),
          )
        }

        // Resolve instance type + whitelist.
        const instanceType =
          input.instanceType ?? config.defaultInstanceType ?? DEFAULT_INSTANCE_TYPE
        const whitelist = config.allowedInstanceTypes
        if (whitelist && whitelist.length > 0 && !whitelist.includes(instanceType)) {
          return yield* Effect.fail(
            new UserError({
              message: `Instance type '${instanceType}' is not in allowedInstanceTypes.`,
              hint: `Pick one of: ${whitelist.join(", ")}`,
            }),
          )
        }

        const timeoutHours =
          input.timeoutHours ?? config.defaultTimeoutHours ?? DEFAULT_TIMEOUT_HOURS
        const timeoutSeconds = Math.floor(timeoutHours * 3600)

        // Build (or skip) the container image.
        const built = yield* build.build({ region, ref: input.ref })

        // Compose handling.
        const composePath = resolve(projectRoot, COMPOSE_FILE)
        const composePresent = existsSync(composePath)
        const mainService = config.mainService ?? DEFAULT_MAIN_SERVICE
        let composeContent: string | undefined
        if (composePresent) {
          const raw = yield* Effect.try({
            try: () => readFileSync(composePath, "utf8"),
            catch: (cause) =>
              new ConfigError({
                path: composePath,
                message: `cannot read: ${String(cause)}`,
              }),
          })
          const lint = yield* Effect.try({
            try: () => lintCompose({ content: raw, mainService }),
            catch: (e) =>
              e instanceof UserError
                ? e
                : new UserError({
                    message: `afk.compose.yml: ${String(e)}`,
                  }),
          })
          for (const w of lint.warnings) {
            console.warn(`warning: ${w}`)
          }
          composeContent = substituteImage(raw, built.image)
        }

        // Log group (created lazily). Skip in dry-run? No — creating an
        // empty log group is cheap and idempotent. Acceptable side-effect.
        const logGroup = `${LOG_GROUP_PREFIX}/${sourceRepoName}`
        yield* logs.ensureLogGroup(region, logGroup, LOG_RETENTION_DAYS)

        const runId = randomUUID()
        const startedAt = new Date().toISOString()

        // Env + secrets.
        const env: Array<{ name: string; value: string }> = envEntries
          .filter((e) => e.kind === "plain")
          .map((e) => ({ name: e.name, value: (e as { value: string }).value }))
        env.push({ name: "AFK_GIT_URL", value: config.gitUrl })
        env.push({ name: "AFK_GIT_SHA", value: built.sha })
        env.push({ name: "AFK_GIT_REF", value: input.ref ?? built.branch })
        env.push({ name: "AFK_RUN_ID", value: runId })
        env.push({ name: "AFK_TIMEOUT_SECONDS", value: String(timeoutSeconds) })

        const secrets = envEntries
          .filter((e) => e.kind === "ssm")
          .map((e) => ({
            name: e.name,
            ssmName: (e as { ssmName: string }).ssmName,
          }))

        // Network lookups.
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
          secrets,
          compose: composeContent,
        })

        const spot = input.onDemand !== true

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

        const plan: RunPlan = {
          runId,
          region,
          accountId: identity.Account,
          repoName: sourceRepoName,
          mainService,
          amiId: golden.imageId,
          instanceType,
          spot,
          timeoutHours,
          timeoutSeconds,
          subnetIds,
          securityGroupId: sgId,
          image: built.image,
          imageWasSkipped: built.skipped,
          branch: built.branch,
          sha: built.sha,
          composePresent,
          composeContent,
          env,
          secrets,
          tags,
          userData,
          logGroup,
          startedAt,
          owner: identity.UserId,
        }
        return plan
      })

    const launch = (plan: RunPlan) =>
      Effect.gen(function* () {
        const { instanceId } = yield* ec2.runInstance({
          region: plan.region,
          imageId: plan.amiId,
          instanceType: plan.instanceType,
          subnetId: plan.subnetIds[Math.floor(Math.random() * plan.subnetIds.length)]!,
          securityGroupIds: [plan.securityGroupId],
          iamInstanceProfileName: AFK_VM_INSTANCE_PROFILE,
          userData: plan.userData,
          spot: plan.spot,
          tags: plan.tags,
        })

        // Best-effort history write — never block a successful launch on it.
        yield* history
          .recordStart({
            runId: plan.runId,
            owner: plan.owner,
            repo: plan.repoName,
            branch: plan.branch,
            sha: plan.sha,
            image: plan.image,
            instanceId,
            instanceType: plan.instanceType,
            spot: plan.spot,
            startedAt: plan.startedAt,
            timeoutHours: plan.timeoutHours,
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
          instanceId,
          image: plan.image,
          branch: plan.branch,
          sha: plan.sha,
          logGroup: plan.logGroup,
          instanceType: plan.instanceType,
          spot: plan.spot,
          composeUsed: plan.composePresent,
        }
        return result
      })

    return RunService.of({
      listAll,
      listMine,
      findByRunId,
      prepare,
      launch,

      start: (input) =>
        Effect.gen(function* () {
          const plan = yield* prepare(input)
          return yield* launch(plan)
        }),

      kill: (runId) =>
        Effect.gen(function* () {
          const run = yield* findByRunId(runId)
          const region = yield* resolveRegion()
          yield* ec2.terminateInstances(region, [run.instanceId])
        }),

      attach: (runId, opts) =>
        Effect.gen(function* () {
          const { config } = yield* cfg.load
          const run = yield* findByRunId(runId)
          // Allow attach against RUNNING, STOPPING, and STOPPED. SSM remains
          // reachable on stopped-but-still-described instances (~1 hour
          // post-shutdown EC2 retention window) which is useful for
          // post-mortem inspection. Only STOPPED && truly gone fails — and
          // that's covered by findByRunId itself returning the row.
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
            yield* ssm.startHostShell({ region, instanceId: run.instanceId })
            return
          }

          // Pick docker exec target. Compose creates containers named
          // <project>_<service>_1 (compose v1) or <project>-<service>-1 (v2);
          // we let `docker compose exec` resolve the name for us. Fallback to
          // `docker exec agent` for non-compose Runs.
          const cmd = [
            "set -e",
            `cd ${VM_AFK_DIR}`,
            // Try compose-aware exec first; fall back to plain docker exec.
            `if [ -f ${VM_COMPOSE_PATH} ]; then`,
            `  docker compose -f ${VM_COMPOSE_PATH} exec ${service} bash 2>/dev/null \\`,
            `    || docker compose -f ${VM_COMPOSE_PATH} exec ${service} sh`,
            `else`,
            `  docker exec -it agent bash 2>/dev/null || docker exec -it agent sh`,
            `fi`,
          ].join("; ")

          yield* ssm.startInteractiveCommand({
            region,
            instanceId: run.instanceId,
            command: cmd,
          })
        }),
    })
  }),
)
