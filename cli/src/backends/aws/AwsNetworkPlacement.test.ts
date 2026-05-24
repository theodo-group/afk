import { describe, it, expect } from "bun:test"
import { Context, Effect, Exit } from "effect"
import { Ec2 } from "../../adapters/aws/Ec2.ts"
import { resolveAfkNetworkPlacement } from "./AwsNetworkPlacement.ts"
import { UserError } from "../../infra/Errors.ts"

const stubEc2 = (
  subnetIds: ReadonlyArray<string>,
): Context.Tag.Service<typeof Ec2> =>
  ({
    findVpcIdByName: () => Effect.succeed("vpc-123"),
    findSubnetIdsByVpcId: () => Effect.succeed(subnetIds),
    findSecurityGroupIdByName: () => Effect.succeed("sg-456"),
  }) as unknown as Context.Tag.Service<typeof Ec2>

describe("resolveAfkNetworkPlacement", () => {
  it("returns subnetIds and securityGroupId when subnets exist", async () => {
    const placement = await Effect.runPromise(
      resolveAfkNetworkPlacement(
        stubEc2(["subnet-a", "subnet-b"]),
        "us-east-1",
      ),
    )
    expect(placement).toEqual({
      subnetIds: ["subnet-a", "subnet-b"],
      securityGroupId: "sg-456",
    })
  })

  it("fails with a UserError when no subnets are found", async () => {
    const exit = await Effect.runPromiseExit(
      resolveAfkNetworkPlacement(stubEc2([]), "us-east-1"),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const error = exit.cause._tag === "Fail" ? exit.cause.error : undefined
      expect(error).toBeInstanceOf(UserError)
    }
  })
})
