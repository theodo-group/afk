import type { Context } from "effect"
import { Effect } from "effect"
import type { AzAuth } from "../../adapters/azure/AzAuth.ts"
import type { ConfigService } from "../../services/ConfigService.ts"
import { UserError } from "../../infra/Errors.ts"
import {
  AZURE_DEFAULT_LOCATION,
  AZURE_DEFAULT_RESOURCE_GROUP,
} from "../../constants.ts"
import {
  type AzureCoords,
  type AzureResourceNames,
  azureResourceNames,
} from "../../adapters/azure/AzureNames.ts"

/**
 * Resolve the Backend's coordinates from `afk.config.json`, falling back to the
 * signed-in `az` subscription. Every `az` call runs against the CLI's *active*
 * subscription, so a config that names another one is refused here rather
 * than letting Runs land, unseen, in the wrong subscription. Bound to the
 * layer's own tags so the service methods built on it carry no requirement.
 */
export const makeResolveAzureCoords = (
  cfg: Context.Tag.Service<typeof ConfigService>,
  auth: Context.Tag.Service<typeof AzAuth>,
) =>
  Effect.gen(function* () {
    const { config } = yield* cfg.load
    const account = yield* auth.account
    const subscriptionId =
      config.azure?.subscriptionId ?? account.subscriptionId
    if (subscriptionId !== account.subscriptionId) {
      return yield* Effect.fail(
        new UserError({
          message: `afk.config.json targets subscription ${subscriptionId}, but az is signed in to ${account.subscriptionId}.`,
          hint: `Run: az account set --subscription ${subscriptionId}`,
        }),
      )
    }
    const coords: AzureCoords = {
      subscriptionId,
      resourceGroup:
        config.azure?.resourceGroup ?? AZURE_DEFAULT_RESOURCE_GROUP,
      location: config.azure?.location ?? AZURE_DEFAULT_LOCATION,
    }
    const names: AzureResourceNames = azureResourceNames(coords)
    return { ...coords, names, account }
  })
