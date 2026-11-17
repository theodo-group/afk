import { describe, expect, it } from "bun:test"
import { azureNameSuffix, azureResourceNames } from "./AzureNames.ts"

const coords = {
  subscriptionId: "00000000-1111-2222-3333-444444444444",
  resourceGroup: "afk",
  location: "westeurope",
}

describe("azureResourceNames", () => {
  it("derives the same names for every developer of a project", () => {
    expect(azureResourceNames(coords)).toEqual(
      azureResourceNames({ ...coords }),
    )
    // Case-insensitive, like Azure's own resource group names.
    expect(azureNameSuffix(coords)).toBe(
      azureNameSuffix({ ...coords, resourceGroup: "AFK" }),
    )
  })

  it("differs across subscriptions, since the names are global", () => {
    expect(azureNameSuffix(coords)).not.toBe(
      azureNameSuffix({ ...coords, subscriptionId: "another" }),
    )
  })

  it("fits each service's naming rules", () => {
    const n = azureResourceNames(coords)
    expect(n.storageAccount).toMatch(/^[a-z0-9]{3,24}$/)
    expect(n.registry).toMatch(/^[a-zA-Z0-9]{5,50}$/)
    expect(n.keyVault).toMatch(/^[a-zA-Z][a-zA-Z0-9-]{1,22}[a-zA-Z0-9]$/)
  })

  it("matches the suffix the Terraform module computes", () => {
    // terraform/azure/main.tf: substr(sha256(lower("<sub>/<rg>")), 0, 12)
    const expected = new Bun.CryptoHasher("sha256")
      .update("00000000-1111-2222-3333-444444444444/afk")
      .digest("hex")
      .slice(0, 12)
    expect(azureNameSuffix(coords)).toBe(expected)
  })
})
