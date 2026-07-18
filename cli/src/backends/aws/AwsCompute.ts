import { Effect, Layer } from "effect"
import { randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { Ec2 } from "../../adapters/aws/Ec2.ts"
import { resolveAfkNetworkPlacement } from "./AwsNetworkPlacement.ts"
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
  type StartInput,
} from "../../services/backend/Compute.ts"
import { ConfigError, UserError } from "../../infra/Errors.ts"
import type { Run } from "../../schema/Run.ts"
import {
  AFK_VM_INSTANCE_PROFILE,
  COMPOSE_FILE,
  DEFAULT_MAIN_SERVICE,
  DEFAULT_REGION,
  DEFAULT_RETENTION_DAYS,
  LOG_RETENTION_DAYS,
  TAG_MANAGED,
  TAG_OWNER,
  VM_AFK_DIR,
} from "../../constants.ts"
import {
  type AwsBackendPlan,
  ec2InstanceToRun,
  finalizeAwsPlan,
  planAwsRun,
  toRunStarted,
} from "./AwsRunPlan.ts"
import { resolveRunByIdPrefix } from "../../services/RunIdPrefix.ts"

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

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

    const resolveRetentionDays = cfg.load.pipe(
      Effect.map((r) => r.config.retentionDays ?? DEFAULT_RETENTION_DAYS),
    )

    const fetchRunsAtRegion = (region: string, ownerUserId?: string) =>
      Effect.gen(function* () {
        const retentionDays = yield* resolveRetentionDays
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
          .map((inst) => ec2InstanceToRun(inst, retentionDays))
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
        return yield* resolveRunByIdPrefix(runId, all)
      })

    const prepare = (input: StartInput) =>
      Effect.gen(function* () {
        // Shell: gather the effectful inputs the core needs.
        const { config, envEntries, projectRoot, sourceRepoName } =
          yield* cfg.load
        const identity = yield* sts.callerIdentity
        const latestGolden = yield* golden.findLatest
        if (!latestGolden) {
          return yield* Effect.fail(
            new UserError({
              message: `No Golden Image found in ${config.aws?.region ?? DEFAULT_REGION}.`,
              hint: "Run `afk golden build` to create one.",
            }),
          )
        }

        const composePath = resolve(projectRoot, COMPOSE_FILE)
        const composeContent = existsSync(composePath)
          ? yield* Effect.try({
              try: () => readFileSync(composePath, "utf8"),
              catch: (cause) =>
                new ConfigError({
                  path: composePath,
                  message: `cannot read: ${String(cause)}`,
                }),
            })
          : undefined

        // Core: pure resolution + validation. Non-deterministic seeds are
        // generated here in the shell and injected, so the core stays testable.
        const core = yield* planAwsRun({
          config,
          envEntries,
          sourceRepoName,
          identity: { Account: identity.Account, UserId: identity.UserId },
          latestGoldenId: latestGolden.id,
          composeContent,
          input,
          runId: randomUUID(),
          startedAt: new Date().toISOString(),
        })
        yield* Effect.forEach(core.warnings, (w) => Effect.logWarning(w))

        // Shell: side effects gated on a valid plan, then pure finalize.
        yield* logs.ensureLogGroup(
          core.region,
          core.preparedBase.logChannel,
          LOG_RETENTION_DAYS,
        )
        const placement = yield* resolveAfkNetworkPlacement(ec2, core.region)
        return finalizeAwsPlan(core, placement)
      })

    const launch = (plan: PreparedRun) =>
      Effect.gen(function* () {
        const aws = plan.backendPlan as AwsBackendPlan

        const { instanceId } = yield* ec2.runInstance({
          region: aws.region,
          imageId: aws.amiId,
          instanceType: aws.instanceType,
          subnetId:
            aws.subnetIds[Math.floor(Math.random() * aws.subnetIds.length)]!,
          securityGroupIds: [aws.securityGroupId],
          iamInstanceProfileName: AFK_VM_INSTANCE_PROFILE,
          userData: aws.userData,
          spot: aws.spot,
          // `stop` on a retained Run (preserve the EBS root for post-mortem
          // attach), `terminate` otherwise. The plan couples this to capacity —
          // only On-Demand can stop (see AwsRunPlan).
          shutdownBehavior: aws.shutdownBehavior,
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
              Effect.logWarning(
                `failed to record run in history table: ${(e as { message?: string }).message ?? String(e)}`,
              ),
            ),
          )

        return toRunStarted(plan, aws, instanceId)
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
        const instanceId = run.resourceId

        const live = run.status === "RUNNING"
        // A stopped instance with a retention window is a retained Run we can
        // resume for post-mortem inspection (its EBS root was preserved).
        // `retainedUntil` is set only when the instance is genuinely *stopped*
        // (not terminated), so it doubles as the resumability marker.
        const resumable = !live && run.retainedUntil !== undefined
        if (!live && !resumable) {
          return yield* Effect.fail(
            new UserError({
              message: `Run ${runId} has ended.`,
              hint: "It was not retained — only an On-Demand Run launched with --retain can be resumed. Declare a Session Artifact to capture state past a Run's end.",
            }),
          )
        }

        // Resume a retained primitive (start the stopped instance, wait for the
        // SSM agent to re-register), and re-park it when the attach session ends
        // so "stopped" stays the retained Run's only resting state. Re-park is
        // best-effort so it always runs.
        const repark = ec2
          .stopInstances(region, [instanceId])
          .pipe(Effect.catchAll(() => Effect.void))
        if (resumable) {
          yield* ec2.startInstances(region, [instanceId])
          yield* ec2.waitForInstance(region, instanceId, "running")
          yield* ssm.waitForAgent({ region, instanceId })
        }

        // Locate the service container by its compose service label (name
        // fallback for the no-compose Run), including exited containers (`-a`)
        // so a retained Run's stopped containers resolve. Using the label avoids
        // `docker compose exec`, which re-interpolates compose.yml and warns on
        // the unset AFK_ENV_FILE.
        const findCid = (svc: string) =>
          `C=$(docker ps -aqf "label=com.docker.compose.service=${svc}" | head -n1); ` +
          `[ -n "$C" ] || C=$(docker ps -aqf "name=^${svc}$" | head -n1); ` +
          `if [ -z "$C" ]; then echo "service ${svc} not found" >&2; exit 1; fi; `

        // Post-mortem: the container has exited, so `exec` is impossible. Commit
        // its final filesystem to an image and run a shell from it (commit-then-
        // run; see CONTEXT.md "Retention"). `--entrypoint` overrides the baked
        // afk entrypoint, which would re-clone /workspace and fail. The main
        // service's env file is preserved on the root volume; pass it through.
        const postMortemCmd = (svc: string) => {
          const img = `afk-postmortem-${run.runId.slice(0, 8)}`
          const envOpt =
            svc === mainService ? `--env-file ${VM_AFK_DIR}/run.env ` : ""
          const drun = (sh: string) =>
            `docker run -it --rm --network host --entrypoint ${sh} ${envOpt}${img}`
          return (
            findCid(svc) +
            `docker commit "$C" ${img} >/dev/null && ` +
            `{ ${drun("bash")} 2>/dev/null || ${drun("sh")}; }; ` +
            `docker image rm ${img} >/dev/null 2>&1 || true`
          )
        }

        const liveCmd = (svc: string) =>
          findCid(svc) +
          `docker exec -it "$C" bash 2>/dev/null || docker exec -it "$C" sh`

        // The SSM session enters as `ssm-user`, who is not in the `docker`
        // group, so every docker call would hit the socket with EACCES. Run the
        // whole snippet under root — passwordless sudo is available on the AL
        // host, and the single PTY is preserved through to `docker exec -it`.
        const dropIn = opts.host
          ? ssm.startHostShell({ region, instanceId })
          : ssm.startInteractiveCommand({
              region,
              instanceId,
              command: `sudo bash -c ${shellQuote(live ? liveCmd(service) : postMortemCmd(service))}`,
            })

        yield* resumable ? dropIn.pipe(Effect.ensuring(repark)) : dropIn
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
