import { Effect, Layer } from "effect"
import { Subprocess } from "../../infra/Subprocess.ts"
import { AzAuth } from "../../adapters/azure/AzAuth.ts"
import { makeAzCli } from "../../adapters/azure/azCli.ts"
import { ConfigService } from "../../services/ConfigService.ts"
import {
  BackendDoctor,
  check,
  type CheckResult,
} from "../../services/backend/BackendDoctor.ts"
import {
  AFK_SUBNET_NAME,
  AZURE_BASTION_NAME,
  AZURE_VNET_NAME,
} from "../../constants.ts"
import { makeResolveAzureCoords } from "./azureCoords.ts"

export const AzureBackendDoctorLive = Layer.effect(
  BackendDoctor,
  Effect.gen(function* () {
    const sub = yield* Subprocess
    const auth = yield* AzAuth
    const cfg = yield* ConfigService
    const az = makeAzCli(sub)
    const coords = makeResolveAzureCoords(cfg, auth)

    const binaryCheck = (bin: string, whenNot: string) =>
      sub.run("which", [bin]).pipe(
        Effect.as(true),
        Effect.catchAll(() => Effect.succeed(false)),
        Effect.map((ok) => check(bin, ok, "found", whenNot)),
      )

    // `afk attach` rides `az network bastion ssh`, which lives in two az
    // extensions rather than the core CLI.
    const extensionCheck = (ext: string) =>
      az
        .exists(["extension", "show", "--name", ext])
        .pipe(
          Effect.map((ok) =>
            check(
              `az extension ${ext}`,
              ok,
              "installed",
              `missing (needed by \`afk attach\`) — run: az extension add --name ${ext}`,
            ),
          ),
        )

    const toolchainChecks = Effect.all([
      binaryCheck("terraform", "not on PATH"),
      binaryCheck("az", "not on PATH — install the Azure CLI"),
      extensionCheck("bastion"),
      extensionCheck("ssh"),
    ])

    const identityCheck = auth.account.pipe(
      Effect.match({
        onFailure: (): CheckResult =>
          check("az account", false, "", "not signed in — run `az login`"),
        onSuccess: (a): CheckResult =>
          check("az account", true, `${a.userName} (${a.subscriptionId})`, ""),
      }),
    )

    // Confirm the resources every Run depends on exist under the names the
    // CLI derives — catches "provisioned, but looked up under another name".
    const probe = (
      name: string,
      args: ReadonlyArray<string>,
      missing: string,
    ) =>
      az
        .exists(args)
        .pipe(Effect.map((ok) => check(name, ok, "found", missing)))

    const placementChecks = coords.pipe(
      Effect.flatMap(({ resourceGroup, names }) => {
        const rg = ["--resource-group", resourceGroup]
        const hint = "— run `afk provision`"
        return Effect.all([
          probe(
            "live resource group",
            ["group", "show", "--name", resourceGroup],
            `resource group '${resourceGroup}' missing ${hint}`,
          ),
          probe(
            "live subnet",
            [
              "network",
              "vnet",
              "subnet",
              "show",
              ...rg,
              "--vnet-name",
              AZURE_VNET_NAME,
              "--name",
              AFK_SUBNET_NAME,
            ],
            `subnet '${AFK_SUBNET_NAME}' missing ${hint}`,
          ),
          probe(
            "live bastion",
            ["network", "bastion", "show", ...rg, "--name", AZURE_BASTION_NAME],
            `bastion '${AZURE_BASTION_NAME}' missing — \`afk attach\` needs it ${hint}`,
          ),
          probe(
            "live container registry",
            ["acr", "show", "--name", names.registry],
            `registry '${names.registry}' missing ${hint}`,
          ),
          probe(
            "live key vault",
            ["keyvault", "show", "--name", names.keyVault],
            `key vault '${names.keyVault}' missing ${hint}`,
          ),
          probe(
            "live storage account",
            [
              "storage",
              "account",
              "show",
              ...rg,
              "--name",
              names.storageAccount,
            ],
            `storage account '${names.storageAccount}' missing ${hint}`,
          ),
        ])
      }),
      Effect.catchAll((e) =>
        Effect.succeed([
          check(
            "live placement",
            false,
            "",
            `could not resolve Azure coordinates: ${e.message}`,
          ),
        ]),
      ),
    )

    const checks = Effect.all([
      toolchainChecks,
      identityCheck,
      placementChecks,
    ]).pipe(
      Effect.map(([toolchain, identity, placement]) => [
        ...toolchain,
        identity,
        ...placement,
      ]),
    )

    return BackendDoctor.of({ checks })
  }),
)
