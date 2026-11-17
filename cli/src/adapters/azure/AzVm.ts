import { Context, Effect, Layer } from "effect"
import { Subprocess } from "../../infra/Subprocess.ts"
import { AzureError } from "../../infra/Errors.ts"
import { makeAzCli, tagArgs } from "./azCli.ts"
import { withTempFile } from "./tempFile.ts"
import { AZURE_ADMIN_USERNAME } from "../../constants.ts"

export interface CreateVmInput {
  readonly resourceGroup: string
  readonly location: string
  readonly name: string
  readonly size: string
  /** A managed image resource id, or a marketplace URN for the golden builder. */
  readonly image: string
  readonly subnetId: string
  /** Resource id of the user-assigned identity the VM runs as. */
  readonly identityId: string
  /** Throwaway OpenSSH public key for the mandatory admin account. */
  readonly adminSshPublicKey: string
  /** Run once by cloud-init on first boot; absent for the golden builder. */
  readonly customData?: string
  /** OS disk size (GB); absent ⇒ the image's own size. */
  readonly osDiskSizeGb?: number
  /** Spot (`--priority Spot`, evicted by deletion) vs Regular On-Demand. */
  readonly spot: boolean
  readonly tags: Readonly<Record<string, string>>
}

export interface AzureVm {
  readonly id: string
  readonly name: string
  /** e.g. "VM running", "VM deallocated"; absent while still being created. */
  readonly powerState?: string
  /** Creating | Updating | Succeeded | Failed | Deleting */
  readonly provisioningState?: string
  readonly size: string
  readonly location: string
  readonly timeCreated?: string
  readonly tags: Readonly<Record<string, string>>
}

export interface CreateImageInput {
  readonly resourceGroup: string
  readonly name: string
  /** The generalized, deallocated VM to capture. */
  readonly sourceVm: string
  readonly tags: Readonly<Record<string, string>>
}

export interface AzureImage {
  readonly id: string
  readonly name: string
  /** Succeeded once the image is usable. */
  readonly provisioningState: string
  readonly tags: Readonly<Record<string, string>>
}

interface RawVm {
  readonly id: string
  readonly name: string
  readonly powerState?: string
  readonly provisioningState?: string
  readonly location: string
  readonly timeCreated?: string
  readonly hardwareProfile?: { readonly vmSize?: string }
  readonly tags?: Record<string, string> | null
}

const toVm = (r: RawVm): AzureVm => ({
  id: r.id,
  name: r.name,
  powerState: r.powerState,
  provisioningState: r.provisioningState,
  size: r.hardwareProfile?.vmSize ?? "",
  location: r.location,
  timeCreated: r.timeCreated,
  tags: r.tags ?? {},
})

/**
 * Azure Compute adapter over `az vm` / `az image` — the analogue of `Gce`.
 * Scoped to one resource group: the Terraform module puts every afk resource
 * in it, so a group-wide listing is the whole Backend's view.
 */
export class AzVm extends Context.Tag("AzVm")<
  AzVm,
  {
    readonly createVm: (
      input: CreateVmInput,
    ) => Effect.Effect<{ readonly id: string }, AzureError>
    /** Sign-in through Microsoft Entra ID, which is what `afk attach` uses. */
    readonly enableEntraLogin: (
      resourceGroup: string,
      name: string,
    ) => Effect.Effect<void, AzureError>
    /** Every VM in the group whose tags include every pair of `tagFilter`. */
    readonly listVms: (
      resourceGroup: string,
      tagFilter: Readonly<Record<string, string>>,
    ) => Effect.Effect<ReadonlyArray<AzureVm>, AzureError>
    readonly deleteVm: (
      resourceGroup: string,
      name: string,
      opts: { readonly wait: boolean },
    ) => Effect.Effect<void, AzureError>
    readonly startVm: (
      resourceGroup: string,
      name: string,
    ) => Effect.Effect<void, AzureError>
    readonly deallocateVm: (
      resourceGroup: string,
      name: string,
    ) => Effect.Effect<void, AzureError>
    readonly generalizeVm: (
      resourceGroup: string,
      name: string,
    ) => Effect.Effect<void, AzureError>
    /** Run a shell script through the VM agent; resolves to its stdout. */
    readonly runShell: (
      resourceGroup: string,
      name: string,
      script: string,
    ) => Effect.Effect<string, AzureError>

    readonly createImage: (
      input: CreateImageInput,
    ) => Effect.Effect<{ readonly id: string }, AzureError>
    readonly listImages: (
      resourceGroup: string,
    ) => Effect.Effect<ReadonlyArray<AzureImage>, AzureError>
    readonly deleteImage: (
      resourceGroup: string,
      name: string,
    ) => Effect.Effect<void, AzureError>
  }
>() {}

// `az vm run-command invoke` folds both streams into one message:
// "Enable succeeded: \n[stdout]\n…\n[stderr]\n…".
const stdoutOf = (message: string): string => {
  const out = message.split("[stdout]\n")[1] ?? ""
  return out.split("\n[stderr]")[0] ?? ""
}

export const AzVmLive = Layer.effect(
  AzVm,
  Effect.gen(function* () {
    const sub = yield* Subprocess
    const az = makeAzCli(sub)

    const createVm = (input: CreateVmInput) => {
      const args = (customDataPath: string | undefined) => [
        "vm",
        "create",
        "--resource-group",
        input.resourceGroup,
        "--location",
        input.location,
        "--name",
        input.name,
        "--image",
        input.image,
        "--size",
        input.size,
        // Managed images cannot be captured from (or booted as) Trusted Launch.
        "--security-type",
        "Standard",
        "--subnet",
        input.subnetId,
        // No public IP and no per-NIC NSG: the subnet's NSG and NAT gateway
        // carry the network policy, and attach reaches the VM through Bastion.
        "--public-ip-address",
        "",
        "--nsg",
        "",
        "--assign-identity",
        input.identityId,
        "--admin-username",
        AZURE_ADMIN_USERNAME,
        "--authentication-type",
        "ssh",
        "--ssh-key-values",
        input.adminSshPublicKey,
        // Delete the VM and its NIC + disk go with it, so a self-reclaimed Run
        // leaves nothing billable behind.
        "--os-disk-delete-option",
        "Delete",
        "--nic-delete-option",
        "Delete",
        ...(input.spot
          ? [
              "--priority",
              "Spot",
              "--eviction-policy",
              "Delete",
              "--max-price",
              "-1",
            ]
          : ["--priority", "Regular"]),
        ...(input.osDiskSizeGb !== undefined
          ? ["--os-disk-size-gb", String(input.osDiskSizeGb)]
          : []),
        ...(customDataPath !== undefined
          ? ["--custom-data", customDataPath]
          : []),
        ...tagArgs(input.tags),
      ]
      const create = (path: string | undefined) =>
        az
          .json<{ readonly id?: string }>("vm:create", args(path))
          .pipe(Effect.map((r) => ({ id: r.id ?? "" })))
      return input.customData === undefined
        ? create(undefined)
        : withTempFile("custom-data.sh", input.customData, create)
    }

    const enableEntraLogin = (resourceGroup: string, name: string) =>
      az.run("vm:extension:set", [
        "vm",
        "extension",
        "set",
        "--resource-group",
        resourceGroup,
        "--vm-name",
        name,
        "--publisher",
        "Microsoft.Azure.ActiveDirectory",
        "--name",
        "AADSSHLoginForLinux",
        "--no-wait",
      ])

    const listVms = (
      resourceGroup: string,
      tagFilter: Readonly<Record<string, string>>,
    ) =>
      az
        .json<ReadonlyArray<RawVm>>("vm:list", [
          "vm",
          "list",
          "--resource-group",
          resourceGroup,
          "--show-details",
        ])
        .pipe(
          Effect.map((vms) =>
            vms
              .map(toVm)
              .filter((vm) =>
                Object.entries(tagFilter).every(([k, v]) => vm.tags[k] === v),
              ),
          ),
        )

    const vmOp =
      (verb: string, extra: ReadonlyArray<string> = []) =>
      (resourceGroup: string, name: string) =>
        az.run(`vm:${verb}`, [
          "vm",
          verb,
          "--resource-group",
          resourceGroup,
          "--name",
          name,
          ...extra,
        ])

    const deleteVm = (
      resourceGroup: string,
      name: string,
      opts: { readonly wait: boolean },
    ) =>
      vmOp("delete", ["--yes", ...(opts.wait ? [] : ["--no-wait"])])(
        resourceGroup,
        name,
      )

    const runShell = (resourceGroup: string, name: string, script: string) =>
      withTempFile("run-command.sh", script, (path) =>
        az.json<{
          readonly value?: ReadonlyArray<{ readonly message?: string }>
        }>("vm:run-command:invoke", [
          "vm",
          "run-command",
          "invoke",
          "--resource-group",
          resourceGroup,
          "--name",
          name,
          "--command-id",
          "RunShellScript",
          "--scripts",
          `@${path}`,
        ]),
      ).pipe(Effect.map((r) => stdoutOf(r.value?.[0]?.message ?? "")))

    const createImage = (input: CreateImageInput) =>
      az
        .json<{ readonly id?: string }>("image:create", [
          "image",
          "create",
          "--resource-group",
          input.resourceGroup,
          "--name",
          input.name,
          "--source",
          input.sourceVm,
          "--hyper-v-generation",
          "V2",
          ...tagArgs(input.tags),
        ])
        .pipe(Effect.map((r) => ({ id: r.id ?? "" })))

    const listImages = (resourceGroup: string) =>
      az
        .json<
          ReadonlyArray<{
            readonly id: string
            readonly name: string
            readonly provisioningState?: string
            readonly tags?: Record<string, string> | null
          }>
        >("image:list", ["image", "list", "--resource-group", resourceGroup])
        .pipe(
          Effect.map((images) =>
            images.map<AzureImage>((i) => ({
              id: i.id,
              name: i.name,
              provisioningState: i.provisioningState ?? "",
              tags: i.tags ?? {},
            })),
          ),
        )

    const deleteImage = (resourceGroup: string, name: string) =>
      az.run("image:delete", [
        "image",
        "delete",
        "--resource-group",
        resourceGroup,
        "--name",
        name,
      ])

    return AzVm.of({
      createVm,
      enableEntraLogin,
      listVms,
      deleteVm,
      startVm: vmOp("start"),
      deallocateVm: vmOp("deallocate"),
      generalizeVm: vmOp("generalize"),
      runShell,
      createImage,
      listImages,
      deleteImage,
    })
  }),
)
