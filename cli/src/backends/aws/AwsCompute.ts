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
  LOG_RETENTION_DAYS,
  TAG_MANAGED,
  TAG_OWNER,
  VM_COMPOSE_PATH,
} from "../../constants.ts"
import {
  type AwsBackendPlan,
  ec2InstanceToRun,
  finalizeAwsPlan,
  planAwsRun,
  toRunStarted,
} from "./AwsRunPlan.ts"

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
          // Retained Runs stop (EBS preserved) on exit; others terminate.
          shutdownBehavior: aws.retain ? "stop" : "terminate",
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

        // A retained Run is a *stopped* (not terminated) instance — its EBS
        // volume survives, so `retainedUntil` is set. Resume it (start, wait for
        // the instance + SSM agent) before entering; re-park (stop) on detach so
        // "retained" stays the only resting state. A non-RUNNING Run without
        // retainedUntil is gone (terminated — e.g. a Spot Run).
        const retained = run.retainedUntil !== undefined
        if (!retained && run.status !== "RUNNING") {
          return yield* Effect.fail(
            new UserError({
              message: `Run ${runId} has ended and was not retained.`,
              hint: "Cloud Runs are retained only when launched on-demand (Spot Runs self-terminate).",
            }),
          )
        }
        if (retained) {
          yield* ec2.startInstances(region, [instanceId])
          yield* ec2.waitForInstance(region, instanceId, "running")
          yield* ssm.waitForAgent({ region, instanceId })
        }

        // Re-park when the session ends (retained only — never stop a live Run).
        const stopInstance = ec2
          .stopInstances(region, [instanceId])
          .pipe(Effect.catchAll(() => Effect.void))

        if (opts.host) {
          const shell = ssm.startHostShell({ region, instanceId })
          yield* retained ? shell.pipe(Effect.ensuring(stopInstance)) : shell
          return
        }

        // Locate the service container by its compose service label (name
        // fallback for the no-compose Run). Using the label avoids
        // `docker compose exec`, which re-interpolates compose.yml and warns on
        // the unset AFK_ENV_FILE.
        const findCid = (svc: string) =>
          `C=$(docker ps -aqf "label=com.docker.compose.service=${svc}" | head -n1); ` +
          `[ -n "$C" ] || C=$(docker ps -aqf "name=^${svc}$" | head -n1); ` +
          `if [ -z "$C" ]; then echo "service ${svc} not found" >&2; exit 1; fi; `

        let cmd: string
        if (retained && service === mainService) {
          // The main service's process has exited; `exec` (or `docker start`,
          // which would re-run the command) is wrong. Bring the sidecars back so
          // the post-mortem shell can reach them, then commit the main
          // container's final filesystem and run a shell from it on host
          // networking, bypassing the baked entrypoint (--entrypoint).
          const img = `afk-postmortem-${runId.slice(0, 8)}`
          cmd =
            `if [ -f ${VM_COMPOSE_PATH} ]; then ` +
            `for s in $(docker compose -f ${VM_COMPOSE_PATH} config --services 2>/dev/null); do ` +
            `if [ "$s" != "${mainService}" ]; then docker compose -f ${VM_COMPOSE_PATH} start "$s" >/dev/null 2>&1 || true; fi; done; fi; ` +
            findCid(mainService) +
            `docker commit "$C" ${img} >/dev/null && ` +
            `{ docker run -it --rm --network host --entrypoint bash ${img} 2>/dev/null || ` +
            `docker run -it --rm --network host --entrypoint sh ${img}; }; ` +
            `docker image rm ${img} >/dev/null 2>&1 || true`
        } else {
          // Live main service, or a sidecar (live, or stopped on a retained Run):
          // start the container if stopped (no-op when running) and `exec` in.
          cmd =
            findCid(service) +
            `docker start "$C" >/dev/null 2>&1 || true; ` +
            `docker exec -it "$C" bash 2>/dev/null || docker exec -it "$C" sh`
        }

        const session = ssm.startInteractiveCommand({
          region,
          instanceId,
          command: cmd,
        })
        yield* retained ? session.pipe(Effect.ensuring(stopInstance)) : session
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
