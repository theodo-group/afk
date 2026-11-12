import { Effect, Either, Layer } from "effect"
import { randomUUID } from "node:crypto"
import { AzVm } from "../../adapters/azure/AzVm.ts"
import { AzAuth } from "../../adapters/azure/AzAuth.ts"
import { Subprocess } from "../../infra/Subprocess.ts"
import { ConfigService } from "../../services/ConfigService.ts"
import { GoldenImageStore } from "../../services/backend/GoldenImage.ts"
import { RunHistory } from "../../services/backend/RunHistory.ts"
import {
  Compute,
  type AttachOptions,
  type PreparedRun,
  type StartInput,
} from "../../services/backend/Compute.ts"
import { AzureError, UserError } from "../../infra/Errors.ts"
import type { Run } from "../../schema/Run.ts"
import { resolveRunByIdPrefix } from "../../services/RunIdPrefix.ts"
import {
  ATTACH_CONTAINER_WAIT_SECONDS,
  ATTACH_CONTAINER_WAIT_TRIES,
  AZURE_BASTION_NAME,
  AZURE_TAG_MANAGED,
  AZURE_TAG_OWNER,
  DEFAULT_MAIN_SERVICE,
  DEFAULT_RETENTION_DAYS,
  VM_AFK_DIR,
} from "../../constants.ts"
import { makeResolveAzureCoords } from "./azureCoords.ts"
import { throwawayAdminPublicKey } from "./AzureSshKey.ts"
import {
  type AzureBackendPlan,
  azureVmToRun,
  planAzureRun,
  toRunStarted,
} from "./AzureRunPlan.ts"

export const AzureComputeLive = Layer.effect(
  Compute,
  Effect.gen(function* () {
    const vms = yield* AzVm
    const auth = yield* AzAuth
    const sub = yield* Subprocess
    const cfg = yield* ConfigService
    const golden = yield* GoldenImageStore
    const history = yield* RunHistory
    const coords = makeResolveAzureCoords(cfg, auth)

    const fetchRuns = (owner?: string) =>
      Effect.gen(function* () {
        const { resourceGroup } = yield* coords
        const { config } = yield* cfg.load
        const retentionDays = config.retentionDays ?? DEFAULT_RETENTION_DAYS
        const found = yield* vms.listVms(resourceGroup, {
          [AZURE_TAG_MANAGED]: "true",
          ...(owner !== undefined ? { [AZURE_TAG_OWNER]: owner } : {}),
        })
        return found
          .map((vm) => azureVmToRun(vm, retentionDays))
          .filter((r): r is Run => r !== null)
      })

    const listAll = fetchRuns()
    const listMine = (owner: string) => fetchRuns(owner)

    const findByRunId = (runId: string) =>
      listAll.pipe(Effect.flatMap((all) => resolveRunByIdPrefix(runId, all)))

    const prepare = (input: StartInput) =>
      Effect.gen(function* () {
        const { config, sourceRepoName } = yield* cfg.load
        const c = yield* coords
        const latestGolden = yield* golden.findLatest
        if (!latestGolden) {
          return yield* Effect.fail(
            new UserError({
              message: "No Golden Image found.",
              hint: "Run `afk golden build` to create one.",
            }),
          )
        }
        const core = yield* Either.match(
          planAzureRun({
            config,
            envEntries: input.envEntries,
            sourceRepoName,
            coords: c,
            names: c.names,
            owner: c.account.userName,
            goldenImageId:
              latestGolden.backendDetails?.resourceId ?? latestGolden.id,
            composeContent: input.composeContent,
            input,
            runId: randomUUID(),
            startedAt: new Date().toISOString(),
            adminSshPublicKey: throwawayAdminPublicKey(),
          }),
          { onLeft: Effect.fail, onRight: Effect.succeed },
        )
        yield* Effect.forEach(core.warnings, (w) => Effect.logWarning(w))
        return core.prepared
      })

    const launch = (plan: PreparedRun) =>
      Effect.gen(function* () {
        const azure = plan.backendPlan as AzureBackendPlan

        yield* vms.createVm({
          resourceGroup: azure.resourceGroup,
          location: azure.location,
          name: azure.vmName,
          size: azure.vmSize,
          image: azure.imageId,
          subnetId: azure.subnetId,
          identityId: azure.identityId,
          adminSshPublicKey: azure.adminSshPublicKey,
          customData: azure.customData,
          osDiskSizeGb: azure.osDiskSizeGb,
          spot: azure.spot,
          tags: azure.tags,
        })

        // Without it `afk attach` cannot sign in; the Run itself is unaffected,
        // so warn rather than fail a launch that has already happened.
        yield* vms
          .enableEntraLogin(azure.resourceGroup, azure.vmName)
          .pipe(
            Effect.catchAll((e) =>
              Effect.logWarning(
                `could not enable Entra ID sign-in — \`afk attach\` will not reach this Run: ${e.message}`,
              ),
            ),
          )

        yield* history
          .recordStart({
            runId: plan.runId,
            owner: plan.owner,
            submittedBy: plan.submittedBy,
            repo: plan.repoName,
            branch: plan.branch,
            sha: plan.sha,
            image: plan.image,
            resourceId: azure.vmName,
            startedAt: azure.startedAt,
            timeoutHours: plan.timeoutHours,
            backendDetails: {
              vmSize: azure.vmSize,
              location: azure.location,
              spot: String(azure.spot),
            },
          })
          .pipe(
            Effect.catchAll((e) =>
              Effect.logWarning(
                `failed to record run in history: ${(e as { message?: string }).message ?? String(e)}`,
              ),
            ),
          )

        return toRunStarted(plan, azure)
      })

    const kill = (runId: string) =>
      Effect.gen(function* () {
        const run = yield* findByRunId(runId)
        const { resourceGroup } = yield* coords
        yield* vms.deleteVm(resourceGroup, run.resourceId, { wait: false })
      })

    const attach = (runId: string, opts: AttachOptions) =>
      Effect.gen(function* () {
        const { config } = yield* cfg.load
        const { resourceGroup, names } = yield* coords
        const run = yield* findByRunId(runId)
        if (run.status === "PROVISIONING") {
          return yield* Effect.fail(
            new UserError({
              message: `Run ${runId} is still PROVISIONING — wait a few seconds.`,
            }),
          )
        }
        const mainService = config.mainService ?? DEFAULT_MAIN_SERVICE
        const service = opts.service ?? mainService
        const vmName = run.resourceId
        const vmId = `${names.scope}/providers/Microsoft.Compute/virtualMachines/${vmName}`

        const live = run.status === "RUNNING"
        // `retainedUntil` is set only on a deallocated afk-retain VM, so it
        // doubles as the resumability marker (as on AWS/GCP).
        const resumable = !live && run.retainedUntil !== undefined
        if (!live && !resumable) {
          return yield* Effect.fail(
            new UserError({
              message: `Run ${runId} has ended.`,
              hint: "It was not retained — only an On-Demand Run launched with --retain can be resumed. Azure otherwise reclaims a Run when its command exits.",
            }),
          )
        }

        // Bastion carries the SSH session (the VM has no public IP) and
        // Microsoft Entra ID signs the developer in. ssh allocates a remote TTY
        // only when given no command, and `docker exec -it` needs one, hence
        // the `-t` passed through after `--`.
        const ssh = (command: string) =>
          sub
            .runInteractive("az", [
              "network",
              "bastion",
              "ssh",
              "--name",
              AZURE_BASTION_NAME,
              "--resource-group",
              resourceGroup,
              "--target-resource-id",
              vmId,
              "--auth-type",
              "AAD",
              "--",
              "-t",
              command,
            ])
            .pipe(
              Effect.mapError(
                (e) =>
                  new AzureError({
                    operation: "network:bastion:ssh",
                    message: e.stderr,
                  }),
              ),
            )

        // A developer signs in as their own Entra account with the "Virtual
        // Machine Administrator Login" role, which is what grants sudo — the
        // Azure counterpart of GCP's per-Owner Docker socket grant.
        const docker = "sudo docker"

        // Locate the service container by its compose label (name fallback
        // for the no-compose Run), exited ones included. A Run is RUNNING
        // minutes before a cold image pull yields a container, so poll.
        const findCid = (svc: string) =>
          `for i in $(seq 1 ${ATTACH_CONTAINER_WAIT_TRIES}); do ` +
          `C=$(${docker} ps -aqf "label=com.docker.compose.service=${svc}" 2>/dev/null | head -n1); ` +
          `[ -n "$C" ] || C=$(${docker} ps -aqf "name=^${svc}$" 2>/dev/null | head -n1); ` +
          `[ -n "$C" ] && break; ` +
          `[ "$i" = 1 ] && echo "afk: waiting for ${svc} to start (the Run may still be pulling its image)..." >&2; ` +
          `sleep ${ATTACH_CONTAINER_WAIT_SECONDS}; done; ` +
          `if [ -z "$C" ]; then echo "afk: ${svc} never started - follow it with \`afk logs\`" >&2; exit 1; fi; `

        const liveCmd = (svc: string) =>
          findCid(svc) +
          `${docker} start "$C" >/dev/null 2>&1 || true; ` +
          `${docker} exec -it "$C" bash 2>/dev/null || ${docker} exec -it "$C" sh`

        // Post-mortem: commit the exited container and run a shell from it.
        // `--entrypoint` skips the baked afk entrypoint (which would re-clone
        // /workspace); the main service's env file is still on the OS disk.
        const postMortemCmd = (svc: string) => {
          const img = `afk-postmortem-${run.runId.slice(0, 8)}`
          const envOpt =
            svc === mainService ? `--env-file ${VM_AFK_DIR}/run.env ` : ""
          const drun = (sh: string) =>
            `${docker} run -it --rm --network host --entrypoint ${sh} ${envOpt}${img}`
          return (
            findCid(svc) +
            `${docker} commit "$C" ${img} >/dev/null && ` +
            `{ ${drun("bash")} 2>/dev/null || ${drun("sh")}; }; ` +
            `${docker} image rm ${img} >/dev/null 2>&1 || true`
          )
        }

        // Re-park a resumed retained Run when the session ends, so
        // "deallocated" stays its only resting state.
        const repark = vms
          .deallocateVm(resourceGroup, vmName)
          .pipe(Effect.catchAll(() => Effect.void))
        if (resumable) {
          yield* vms.startVm(resourceGroup, vmName)
        }

        const dropIn = opts.host
          ? ssh("bash -l")
          : ssh(live ? liveCmd(service) : postMortemCmd(service))
        yield* resumable ? dropIn.pipe(Effect.ensuring(repark)) : dropIn
      })

    const callerPrincipal = auth.account.pipe(
      Effect.map((a) => ({ id: a.userName, displayName: a.userName })),
    )

    return Compute.of({
      backendName: "azure",
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
