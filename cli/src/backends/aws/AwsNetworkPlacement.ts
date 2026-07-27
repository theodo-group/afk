import { Context, Effect } from "effect"
import { Ec2 } from "../../adapters/aws/Ec2.ts"
import { AwsError, UserError } from "../../infra/Errors.ts"
import { AFK_SECURITY_GROUP, AFK_VPC_NAME } from "../../constants.ts"

export interface AwsNetworkPlacement {
  readonly subnetIds: ReadonlyArray<string>
  readonly securityGroupId: string
}

/**
 * Explicit network placement configured in `aws.subnetIds`/`aws.securityGroupId`.
 * When both are supplied, discovery is skipped and these are used verbatim.
 */
export interface NetworkPlacementConfig {
  readonly subnetIds?: ReadonlyArray<string>
  readonly securityGroupId?: string
}

/**
 * Resolve the network placement a Run (or golden-image builder VM) launches
 * into. When `config` supplies both an explicit subnet set and a security group
 * (e.g. an existing CDA-managed VPC), those are returned verbatim and no AWS
 * describe calls are made. Otherwise the AFK VPC's subnets and security group
 * are discovered by tag; the VPC id is purely intermediate — callers only ever
 * need the subnets + security group.
 */
export const resolveAfkNetworkPlacement = (
  ec2: Context.Tag.Service<typeof Ec2>,
  region: string,
  config?: NetworkPlacementConfig,
): Effect.Effect<AwsNetworkPlacement, AwsError | UserError> =>
  Effect.gen(function* () {
    if (
      config?.subnetIds &&
      config.subnetIds.length > 0 &&
      config.securityGroupId
    ) {
      return {
        subnetIds: config.subnetIds,
        securityGroupId: config.securityGroupId,
      }
    }
    const vpcId = yield* ec2.findVpcIdByName(region, AFK_VPC_NAME)
    const subnetIds = yield* ec2.findSubnetIdsByVpcId(region, vpcId)
    if (subnetIds.length === 0) {
      return yield* Effect.fail(
        new UserError({
          message: `No subnets found in VPC '${AFK_VPC_NAME}'.`,
          hint: "Apply the AFK Terraform first.",
        }),
      )
    }
    const securityGroupId = yield* ec2.findSecurityGroupIdByName(
      region,
      vpcId,
      AFK_SECURITY_GROUP,
    )
    return { subnetIds, securityGroupId }
  })
