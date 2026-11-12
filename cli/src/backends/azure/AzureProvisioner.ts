import { Effect, Layer } from "effect"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { ConfigService } from "../../services/ConfigService.ts"
import { AzAuth } from "../../adapters/azure/AzAuth.ts"
import { Terraform } from "../../adapters/Terraform.ts"
import { Output } from "../../infra/Output.ts"
import { UserError } from "../../infra/Errors.ts"
import { Provisioner } from "../../services/backend/Provisioner.ts"
import { DEFAULT_RETENTION_DAYS } from "../../constants.ts"
import { makeResolveAzureCoords } from "./azureCoords.ts"

/**
 * Azure provisioning runs the Terraform module dropped at `terraform/azure` —
 * resource group, VNet + NAT gateway + Bastion, the Run identity and the
 * developer role, ACR, Key Vault, the storage account (run index, logs,
 * Session Artifacts) and the sweeper Function — for the developer.
 */
export const AzureProvisionerLive = Layer.effect(
  Provisioner,
  Effect.gen(function* () {
    const cfg = yield* ConfigService
    const auth = yield* AzAuth
    const tf = yield* Terraform
    const out = yield* Output
    const coords = makeResolveAzureCoords(cfg, auth)

    // Provisioner's error channel has no AzureError: an az failure here is
    // something the developer fixes by signing in, so it is a UserError.
    const asUserError = <A, R>(
      e: Effect.Effect<A, { readonly message: string }, R>,
    ) =>
      e.pipe(
        Effect.mapError(
          (err) =>
            new UserError({
              message: err.message,
              hint: "Check `az login` and `az account show`.",
            }),
        ),
      )

    const provision = Effect.gen(function* () {
      const { config, projectRoot } = yield* cfg.load
      const dir = resolve(projectRoot, "terraform", "azure")
      if (!existsSync(dir)) {
        return yield* Effect.fail(
          new UserError({
            message: `no terraform/azure module at ${dir}.`,
            hint: "Run `afk init --provider azure` first.",
          }),
        )
      }
      const c = yield* asUserError(coords)
      // The founding developer's roles need a concrete principal at apply
      // time; derive it from the signed-in az principal. `afk team add` adds
      // more later.
      const objectId = yield* asUserError(auth.objectId)
      yield* out.print(
        `• terraform init + apply (subscription ${c.subscriptionId}, resource group ${c.resourceGroup}, ${c.location})…`,
      )
      yield* tf.apply({
        dir,
        vars: {
          subscription_id: c.subscriptionId,
          location: c.location,
          resource_group: c.resourceGroup,
          developer_object_id: objectId,
          developer_principal_type:
            c.account.userType === "servicePrincipal"
              ? "ServicePrincipal"
              : "User",
          retention_days: String(
            config.retentionDays ?? DEFAULT_RETENTION_DAYS,
          ),
        },
      })

      return {
        summary:
          "✓ Azure backend provisioned (VNet + NAT + Bastion, identities, ACR, Key Vault, storage, sweeper).",
        details: {
          backend: "azure",
          subscriptionId: c.subscriptionId,
          resourceGroup: c.resourceGroup,
          location: c.location,
          terraformDir: dir,
        },
        nextSteps: [
          "afk golden build                     # build the Golden managed image",
          "afk secrets put github-token <PAT>   # so Runs can clone source",
          'afk run "<command>"',
        ],
      }
    })

    return Provisioner.of({ provision })
  }),
)
