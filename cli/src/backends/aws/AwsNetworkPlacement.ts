import { Context, Effect } from "effect"
import { Ec2 } from "../../adapters/aws/Ec2.ts"
import { AwsError, UserError } from "../../infra/Errors.ts"
import { AFK_SECURITY_GROUP, AFK_VPC_NAME } from "../../constants.ts"

export interface AwsNetworkPlacement {
  readonly subnetIds: ReadonlyArray<string>
  readonly securityGroupId: string
}

/**
 * Resolve the AFK VPC's subnets and security group into the network placement a
 * Run (or golden-image builder VM) launches into. The VPC id is purely
 * intermediate; callers only ever need the subnets + security group.
 */
export const resolveAfkNetworkPlacement = (
  ec2: Context.Tag.Service<typeof Ec2>,
  region: string,
): Effect.Effect<AwsNetworkPlacement, AwsError | UserError> =>
  Effect.gen(function* () {
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
