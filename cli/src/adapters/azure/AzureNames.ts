import { createHash } from "node:crypto"
import {
  AZURE_NAME_SUFFIX_LENGTH,
  AZURE_RUN_IDENTITY,
  AZURE_VNET_NAME,
  AFK_SUBNET_NAME,
} from "../../constants.ts"

/** Where the Azure Backend lives: one resource group in one subscription. */
export interface AzureCoords {
  readonly subscriptionId: string
  readonly resourceGroup: string
  readonly location: string
}

/**
 * Every name and id the CLI addresses inside the afk resource group. The
 * Terraform module names the same resources from the same `nameSuffix`, so the
 * two agree without the CLI reading Terraform state.
 */
export interface AzureResourceNames {
  /** `afk<suffix>` — Storage accounts are [a-z0-9]{3,24}, globally unique. */
  readonly storageAccount: string
  /** `afk<suffix>` — ACR names are [a-zA-Z0-9]{5,50}, globally unique. */
  readonly registry: string
  /** `afk-<suffix>` — Key Vault names are [a-zA-Z0-9-]{3,24}, globally unique. */
  readonly keyVault: string
  /** Custom role definitions are unique per tenant, hence suffixed as well. */
  readonly developerRole: string
  readonly scope: string
  readonly subnetId: string
  readonly identityId: string
}

/**
 * The global-uniqueness suffix: a hash of the subscription and the resource
 * group, so two projects in two subscriptions never collide while every
 * developer of one project derives the same names. Pure.
 */
export const azureNameSuffix = (coords: {
  readonly subscriptionId: string
  readonly resourceGroup: string
}): string =>
  createHash("sha256")
    .update(`${coords.subscriptionId}/${coords.resourceGroup}`.toLowerCase())
    .digest("hex")
    .slice(0, AZURE_NAME_SUFFIX_LENGTH)

/** Pure. */
export const azureResourceNames = (coords: AzureCoords): AzureResourceNames => {
  const suffix = azureNameSuffix(coords)
  const scope = `/subscriptions/${coords.subscriptionId}/resourceGroups/${coords.resourceGroup}`
  return {
    storageAccount: `afk${suffix}`,
    registry: `afk${suffix}`,
    keyVault: `afk-${suffix}`,
    developerRole: `afk-developer-${suffix}`,
    scope,
    subnetId: `${scope}/providers/Microsoft.Network/virtualNetworks/${AZURE_VNET_NAME}/subnets/${AFK_SUBNET_NAME}`,
    identityId: `${scope}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${AZURE_RUN_IDENTITY}`,
  }
}
