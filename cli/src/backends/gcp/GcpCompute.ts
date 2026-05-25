import { Effect, Layer } from "effect"
import { randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { Gce } from "../../adapters/gcp/Gce.ts"
import { Auth } from "../../adapters/gcp/Auth.ts"
import { Subprocess } from "../../infra/Subprocess.ts"
import { resolveGcpNetworkPlacement } from "./GcpNetworkPlacement.ts"
import { ConfigService } from "../../services/ConfigService.ts"
import { GoldenImageStore } from "../../services/backend/GoldenImage.ts"
import { RunHistory } from "../../services/backend/RunHistory.ts"
import {
  Compute,
  type AttachOptions,
  type PreparedRun,
  type StartInput,
} from "../../services/backend/Compute.ts"
import { ConfigError, GcpError, UserError } from "../../infra/Errors.ts"
import type { Run } from "../../schema/Run.ts"
import { injectGcpLogging } from "../../services/Compose.ts"
import {
  COMPOSE_FILE,
  DEFAULT_MAIN_SERVICE,
  GCP_DEFAULT_REGION,
  GCP_DEFAULT_ZONE,
  GCP_GOLDEN_IMAGE_FAMILY,
  GCP_LABEL_MANAGED,
  GCP_LABEL_OWNER,
} from "../../constants.ts"
import {
  type GcpBackendPlan,
  finalizeGcpPlan,
  gceInstanceToRun,
  planGcpRun,
  sanitizeLabel,
  toRunStarted,
} from "./GcpRunPlan.ts"

export const GcpComputeLive = Layer.effect(
  Compute,
  Effect.gen(function* () {
    const gce = yield* Gce
    const auth = yield* Auth
    const sub = yield* Subprocess
    const cfg = yield* ConfigService
    const golden = yield* GoldenImageStore
    const history = yield* RunHistory

    const resolveProject = Effect.gen(function* () {
      const { config } = yield* cfg.load
      return config.gcp?.projectId ?? (yield* auth.activeProject)
    })

    const resolveRegionZone = cfg.load.pipe(
      Effect.map((r) => ({
        region: r.config.gcp?.region ?? GCP_DEFAULT_REGION,
        zone: r.config.gcp?.zone ?? GCP_DEFAULT_ZONE,
      })),
    )

    const fetchRuns = (ownerAccount?: string) =>
      Effect.gen(function* () {
        const project = yield* resolveProject
        const { zone } = yield* resolveRegionZone
        const labelFilters = [
          { key: GCP_LABEL_MANAGED, value: "true" },
          ...(ownerAccount
            ? [{ key: GCP_LABEL_OWNER, value: sanitizeLabel(ownerAccount) }]
            : []),
        ]
        const instances = yield* gce.listInstances({
          project,
          zone,
          labelFilters,
        })
        return instances
          .map(gceInstanceToRun)
          .filter((r): r is Run => r !== null)
      })

    const listAll = fetchRuns()
    const listMine = (ownerUserId: string) => fetchRuns(ownerUserId)

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
        const { config, envEntries, projectRoot, sourceRepoName } =
          yield* cfg.load
        const ownerAccount = yield* auth.callerAccount
        const project = config.gcp?.projectId ?? (yield* auth.activeProject)

        const latestGolden = yield* golden.findLatest
        if (!latestGolden) {
          return yield* Effect.fail(
            new UserError({
              message: "No Golden Image found.",
              hint: "Run `afk golden build` to create one.",
            }),
          )
        }

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
        // Inject the gcplogs driver + per-service labels so `afk logs` can filter
        // Cloud Logging per service (the core then substitutes ${AFK_IMAGE}).
        const composeContent = composeRaw
          ? injectGcpLogging(composeRaw, runId)
          : undefined

        const core = yield* planGcpRun({
          config,
          envEntries,
          sourceRepoName,
          project,
          ownerAccount,
          goldenImageFamily: GCP_GOLDEN_IMAGE_FAMILY,
          composeContent,
          input,
          runId,
          startedAt: new Date().toISOString(),
        })
        yield* Effect.forEach(core.warnings, (w) => Effect.logWarning(w))

        const placement = resolveGcpNetworkPlacement(core.project, core.region)
        return finalizeGcpPlan(core, placement)
      })

    const launch = (plan: PreparedRun) =>
      Effect.gen(function* () {
        const gcp = plan.backendPlan as GcpBackendPlan

        const { name } = yield* gce.createInstance({
          project: gcp.project,
          zone: gcp.zone,
          name: gcp.instanceName,
          machineType: gcp.machineType,
          image: `family/${gcp.imageFamily}`,
          serviceAccount: gcp.serviceAccount,
          subnet: gcp.subnet,
          startupScript: gcp.startupScript,
          spot: gcp.spot,
          maxRunDurationSeconds: gcp.maxRunDurationSeconds,
          labels: gcp.labels,
        })

        yield* history
          .recordStart({
            runId: plan.runId,
            owner: plan.owner,
            repo: plan.repoName,
            branch: plan.branch,
            sha: plan.sha,
            image: plan.image,
            resourceId: name,
            startedAt: gcp.startedAt,
            timeoutHours: plan.timeoutHours,
            backendDetails: {
              machineType: gcp.machineType,
              zone: gcp.zone,
              spot: String(gcp.spot),
            },
          })
          .pipe(
            Effect.catchAll((e) =>
              Effect.logWarning(
                `failed to record run in history: ${(e as { message?: string }).message ?? String(e)}`,
              ),
            ),
          )

        return toRunStarted(plan, gcp, name)
      })

    const kill = (runId: string) =>
      Effect.gen(function* () {
        const run = yield* findByRunId(runId)
        const project = yield* resolveProject
        const { zone } = yield* resolveRegionZone
        yield* gce.deleteInstance(project, zone, run.resourceId)
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
        // GCP reclaims immediately, so a non-RUNNING Run is gone — there is no
        // retained state to resume into (mirrors the non-retained AWS path).
        if (run.status !== "RUNNING") {
          return yield* Effect.fail(
            new UserError({
              message: `Run ${runId} has ended.`,
              hint: "GCP Runs are reclaimed when their command exits.",
            }),
          )
        }
        const project = config.gcp?.projectId ?? (yield* auth.activeProject)
        const zone = config.gcp?.zone ?? GCP_DEFAULT_ZONE
        const mainService = config.mainService ?? DEFAULT_MAIN_SERVICE
        const service = opts.service ?? mainService
        const instanceName = run.resourceId

        const ssh = (command: string) =>
          sub
            .runInteractive("gcloud", [
              "compute",
              "ssh",
              instanceName,
              `--project=${project}`,
              `--zone=${zone}`,
              "--tunnel-through-iap",
              "--command",
              command,
            ])
            .pipe(
              Effect.mapError(
                (e) =>
                  new GcpError({
                    operation: "compute:ssh",
                    message: e.stderr,
                  }),
              ),
            )

        if (opts.host) {
          yield* ssh("bash -l")
          return
        }

        // Locate the service container by its compose service label (name
        // fallback for the no-compose Run), then exec a shell into it — the same
        // shape as the AWS SSM path, run over the IAP SSH tunnel.
        const findCid =
          `C=$(docker ps -aqf "label=com.docker.compose.service=${service}" | head -n1); ` +
          `[ -n "$C" ] || C=$(docker ps -aqf "name=^${service}$" | head -n1); ` +
          `if [ -z "$C" ]; then echo "service ${service} not found" >&2; exit 1; fi; `
        const cmd =
          findCid +
          `docker start "$C" >/dev/null 2>&1 || true; ` +
          `docker exec -it "$C" bash 2>/dev/null || docker exec -it "$C" sh`
        yield* ssh(cmd)
      })

    const callerPrincipal = Effect.gen(function* () {
      const account = yield* auth.callerAccount
      return { id: account, displayName: account }
    })

    return Compute.of({
      backendName: "gcp",
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
