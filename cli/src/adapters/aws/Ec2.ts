import { Context, Effect, Layer } from "effect"
import { Subprocess } from "../../infra/Subprocess.ts"
import { AwsError } from "../../infra/Errors.ts"

const awsError = (op: string) => (e: { _tag: string; stderr?: string; cause?: unknown }) =>
  new AwsError({
    operation: op,
    message: e._tag === "ParseError" ? String(e.cause) : (e.stderr ?? ""),
  })

export class Ec2 extends Context.Tag("Ec2")<
  Ec2,
  {
    readonly findSubnetIdsByVpcName: (
      vpcName: string,
    ) => Effect.Effect<ReadonlyArray<string>, AwsError>
    readonly findSecurityGroupIdByName: (
      vpcName: string,
      sgName: string,
    ) => Effect.Effect<string, AwsError>
  }
>() {}

export const Ec2Live = Layer.effect(
  Ec2,
  Effect.gen(function* () {
    const sub = yield* Subprocess

    const findVpcId = (vpcName: string) =>
      sub
        .runJson<{ Vpcs: ReadonlyArray<{ VpcId: string }> }>("aws", [
          "ec2",
          "describe-vpcs",
          "--filters",
          `Name=tag:Name,Values=${vpcName}`,
          "--output",
          "json",
        ])
        .pipe(
          Effect.flatMap((r) => {
            const vpc = r.Vpcs[0]
            if (!vpc)
              return Effect.fail(
                new AwsError({
                  operation: "ec2:DescribeVpcs",
                  message: `VPC '${vpcName}' not found`,
                }),
              )
            return Effect.succeed(vpc.VpcId)
          }),
          Effect.mapError((e) =>
            e instanceof AwsError ? e : awsError("ec2:DescribeVpcs")(e),
          ),
        )

    return Ec2.of({
      findSubnetIdsByVpcName: (vpcName) =>
        Effect.gen(function* () {
          const vpcId = yield* findVpcId(vpcName)
          return yield* sub
            .runJson<{ Subnets: ReadonlyArray<{ SubnetId: string }> }>("aws", [
              "ec2",
              "describe-subnets",
              "--filters",
              `Name=vpc-id,Values=${vpcId}`,
              `Name=tag:afk:managed,Values=true`,
              "--output",
              "json",
            ])
            .pipe(
              Effect.map((r) => r.Subnets.map((s) => s.SubnetId)),
              Effect.mapError(awsError("ec2:DescribeSubnets")),
            )
        }),
      findSecurityGroupIdByName: (vpcName, sgName) =>
        Effect.gen(function* () {
          const vpcId = yield* findVpcId(vpcName)
          return yield* sub
            .runJson<{
              SecurityGroups: ReadonlyArray<{ GroupId: string }>
            }>("aws", [
              "ec2",
              "describe-security-groups",
              "--filters",
              `Name=vpc-id,Values=${vpcId}`,
              `Name=group-name,Values=${sgName}`,
              "--output",
              "json",
            ])
            .pipe(
              Effect.flatMap((r) => {
                const sg = r.SecurityGroups[0]
                if (!sg)
                  return Effect.fail(
                    new AwsError({
                      operation: "ec2:DescribeSecurityGroups",
                      message: `security group '${sgName}' not found in VPC '${vpcName}'`,
                    }),
                  )
                return Effect.succeed(sg.GroupId)
              }),
              Effect.mapError((e) =>
                e instanceof AwsError
                  ? e
                  : awsError("ec2:DescribeSecurityGroups")(e),
              ),
            )
        }),
    })
  }),
)
