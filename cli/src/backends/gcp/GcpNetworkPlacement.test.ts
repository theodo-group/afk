import { describe, it, expect } from "bun:test"
import { resolveGcpNetworkPlacement } from "./GcpNetworkPlacement.ts"
import { AFK_SUBNET_NAME, GCP_VM_SERVICE_ACCOUNT } from "../../constants.ts"

describe("resolveGcpNetworkPlacement", () => {
  it("derives the region-scoped afk subnet self-link", () => {
    const { subnet } = resolveGcpNetworkPlacement("acme-prod", "us-central1")
    expect(subnet).toBe(
      `projects/acme-prod/regions/us-central1/subnetworks/${AFK_SUBNET_NAME}`,
    )
  })

  it("derives the per-Run instance service account email", () => {
    const { serviceAccount } = resolveGcpNetworkPlacement(
      "acme-prod",
      "us-central1",
    )
    expect(serviceAccount).toBe(
      `${GCP_VM_SERVICE_ACCOUNT}@acme-prod.iam.gserviceaccount.com`,
    )
  })

  it("is pure — same inputs yield identical placement", () => {
    expect(resolveGcpNetworkPlacement("p", "europe-west1")).toEqual(
      resolveGcpNetworkPlacement("p", "europe-west1"),
    )
  })
})
