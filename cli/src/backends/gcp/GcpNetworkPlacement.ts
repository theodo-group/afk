import { AFK_SUBNET_NAME, GCP_VM_SERVICE_ACCOUNT } from "../../constants.ts"

export interface GcpNetworkPlacement {
  /** The afk subnet a Run launches into (region-scoped, no external IP). */
  readonly subnet: string
  /** The per-Run instance service account email. */
  readonly serviceAccount: string
}

/**
 * Resolve the afk VPC subnet + the instance service account a Run launches with.
 * Far simpler than the AWS equivalent: the Terraform module names both by
 * convention (subnet `afk-subnet` in the Run's region, SA `afk-vm@<project>`), so
 * no live lookup is needed — pure derivation from project + region.
 */
export const resolveGcpNetworkPlacement = (
  project: string,
  region: string,
): GcpNetworkPlacement => ({
  subnet: `projects/${project}/regions/${region}/subnetworks/${AFK_SUBNET_NAME}`,
  serviceAccount: `${GCP_VM_SERVICE_ACCOUNT}@${project}.iam.gserviceaccount.com`,
})
