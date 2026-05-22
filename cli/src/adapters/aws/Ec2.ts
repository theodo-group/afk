import { Context, Effect, Layer } from "effect"
import { Subprocess } from "../../infra/Subprocess.ts"
import { AwsError } from "../../infra/Errors.ts"

export interface Tag {
  readonly key: string
  readonly value: string
}

export interface RunInstanceInput {
  readonly region: string
  readonly imageId: string
  readonly instanceType: string
  readonly subnetId: string
  readonly securityGroupIds: ReadonlyArray<string>
  readonly iamInstanceProfileName: string
  readonly userData: string
  readonly spot: boolean
  /** Tags applied to the instance + volumes at launch. */
  readonly tags: ReadonlyArray<Tag>
}

export interface Ec2Instance {
  readonly instanceId: string
  readonly state: string // pending | running | shutting-down | stopping | stopped | terminated
  readonly instanceType: string
  readonly launchTime?: string
  readonly publicIp?: string
  readonly privateIp?: string
  readonly imageId: string
  readonly tags: ReadonlyArray<Tag>
  readonly spotInstanceRequestId?: string
  readonly stateReason?: string
}

export interface Ec2Image {
  readonly imageId: string
  readonly name?: string
  readonly creationDate?: string
  readonly state: string
  readonly tags: ReadonlyArray<Tag>
}

export interface DescribeInstancesInput {
  readonly region: string
  readonly tagFilters?: ReadonlyArray<{ key: string; values: ReadonlyArray<string> }>
  readonly instanceIds?: ReadonlyArray<string>
  readonly states?: ReadonlyArray<string>
}

export interface DescribeImagesInput {
  readonly region: string
  readonly owners?: ReadonlyArray<string>
  readonly tagFilters?: ReadonlyArray<{ key: string; values: ReadonlyArray<string> }>
  readonly imageIds?: ReadonlyArray<string>
}

export interface CreateImageInput {
  readonly region: string
  readonly instanceId: string
  readonly name: string
  readonly description?: string
  readonly tags: ReadonlyArray<Tag>
  /** Reboot the instance for a clean snapshot. AWS default is true. */
  readonly noReboot?: boolean
}

export interface GetParameterInput {
  readonly region: string
  readonly name: string
}

const awsError = (op: string) => (e: { _tag: string; stderr?: string; cause?: unknown }) =>
  new AwsError({
    operation: op,
    message: e._tag === "ParseError" ? String(e.cause) : (e.stderr ?? ""),
  })

const parseTags = (raw: ReadonlyArray<{ Key?: string; Value?: string }> | undefined): Tag[] =>
  (raw ?? [])
    .filter((t): t is { Key: string; Value: string } => !!t.Key && t.Value !== undefined)
    .map((t) => ({ key: t.Key, value: t.Value }))

const tagsCli = (tags: ReadonlyArray<Tag>): string =>
  tags.map((t) => `Key=${t.key},Value=${t.value}`).join(" ")

const filterArg = (filters: ReadonlyArray<{ name: string; values: ReadonlyArray<string> }>): string[] => {
  if (filters.length === 0) return []
  return ["--filters", ...filters.map((f) => `Name=${f.name},Values=${f.values.join(",")}`)]
}

export class Ec2 extends Context.Tag("Ec2")<
  Ec2,
  {
    readonly findVpcIdByName: (
      region: string,
      vpcName: string,
    ) => Effect.Effect<string, AwsError>
    readonly findSubnetIdsByVpcId: (
      region: string,
      vpcId: string,
    ) => Effect.Effect<ReadonlyArray<string>, AwsError>
    readonly findSecurityGroupIdByName: (
      region: string,
      vpcId: string,
      sgName: string,
    ) => Effect.Effect<string, AwsError>
    readonly findLatestAmazonLinuxAmi: (
      region: string,
    ) => Effect.Effect<string, AwsError>

    readonly runInstance: (
      input: RunInstanceInput,
    ) => Effect.Effect<{ readonly instanceId: string }, AwsError>
    readonly describeInstances: (
      input: DescribeInstancesInput,
    ) => Effect.Effect<ReadonlyArray<Ec2Instance>, AwsError>
    readonly terminateInstances: (
      region: string,
      instanceIds: ReadonlyArray<string>,
    ) => Effect.Effect<void, AwsError>
    readonly waitForInstance: (
      region: string,
      instanceId: string,
      state: "running" | "stopped" | "terminated",
    ) => Effect.Effect<void, AwsError>

    readonly describeImages: (
      input: DescribeImagesInput,
    ) => Effect.Effect<ReadonlyArray<Ec2Image>, AwsError>
    readonly createImage: (
      input: CreateImageInput,
    ) => Effect.Effect<{ readonly imageId: string }, AwsError>
    readonly waitForImage: (
      region: string,
      imageId: string,
    ) => Effect.Effect<void, AwsError>
    readonly deregisterImage: (
      region: string,
      imageId: string,
    ) => Effect.Effect<void, AwsError>
  }
>() {}

export const Ec2Live = Layer.effect(
  Ec2,
  Effect.gen(function* () {
    const sub = yield* Subprocess

    const findVpcIdByName = (region: string, vpcName: string) =>
      sub
        .runJson<{ Vpcs: ReadonlyArray<{ VpcId: string }> }>("aws", [
          "ec2",
          "describe-vpcs",
          "--region",
          region,
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
                  message: `VPC '${vpcName}' not found in ${region}`,
                }),
              )
            return Effect.succeed(vpc.VpcId)
          }),
          Effect.mapError((e) =>
            e instanceof AwsError ? e : awsError("ec2:DescribeVpcs")(e),
          ),
        )

    const findSubnetIdsByVpcId = (region: string, vpcId: string) =>
      sub
        .runJson<{ Subnets: ReadonlyArray<{ SubnetId: string }> }>("aws", [
          "ec2",
          "describe-subnets",
          "--region",
          region,
          "--filters",
          `Name=vpc-id,Values=${vpcId}`,
          "--output",
          "json",
        ])
        .pipe(
          Effect.map((r) => r.Subnets.map((s) => s.SubnetId)),
          Effect.mapError(awsError("ec2:DescribeSubnets")),
        )

    const findSecurityGroupIdByName = (region: string, vpcId: string, sgName: string) =>
      sub
        .runJson<{ SecurityGroups: ReadonlyArray<{ GroupId: string }> }>("aws", [
          "ec2",
          "describe-security-groups",
          "--region",
          region,
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
                  message: `security group '${sgName}' not found in VPC '${vpcId}'`,
                }),
              )
            return Effect.succeed(sg.GroupId)
          }),
          Effect.mapError((e) =>
            e instanceof AwsError ? e : awsError("ec2:DescribeSecurityGroups")(e),
          ),
        )

    // SSM public parameter that always points at the latest AL2023 x86_64 AMI.
    const findLatestAmazonLinuxAmi = (region: string) =>
      sub
        .runJson<{ Parameter: { Value: string } }>("aws", [
          "ssm",
          "get-parameter",
          "--region",
          region,
          "--name",
          "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64",
          "--output",
          "json",
        ])
        .pipe(
          Effect.map((r) => r.Parameter.Value),
          Effect.mapError(awsError("ssm:GetParameter")),
        )

    const runInstance = (input: RunInstanceInput) => {
      const tagSpec = [
        {
          ResourceType: "instance",
          Tags: input.tags.map((t) => ({ Key: t.key, Value: t.value })),
        },
        {
          ResourceType: "volume",
          Tags: input.tags.map((t) => ({ Key: t.key, Value: t.value })),
        },
      ]
      const args: string[] = [
        "ec2",
        "run-instances",
        "--region",
        input.region,
        "--image-id",
        input.imageId,
        "--instance-type",
        input.instanceType,
        "--subnet-id",
        input.subnetId,
        "--security-group-ids",
        ...input.securityGroupIds,
        "--iam-instance-profile",
        `Name=${input.iamInstanceProfileName}`,
        "--user-data",
        Buffer.from(input.userData, "utf8").toString("base64"),
        "--instance-initiated-shutdown-behavior",
        "terminate",
        "--metadata-options",
        "HttpTokens=required,HttpEndpoint=enabled,InstanceMetadataTags=enabled",
        "--tag-specifications",
        JSON.stringify(tagSpec),
        "--count",
        "1",
        "--associate-public-ip-address",
        "--output",
        "json",
      ]
      if (input.spot) {
        args.push(
          "--instance-market-options",
          JSON.stringify({
            MarketType: "spot",
            SpotOptions: { SpotInstanceType: "one-time", InstanceInterruptionBehavior: "terminate" },
          }),
        )
      }
      return sub
        .runJson<{ Instances: ReadonlyArray<{ InstanceId: string }> }>("aws", args)
        .pipe(
          Effect.flatMap((r) => {
            const inst = r.Instances[0]
            if (!inst)
              return Effect.fail(
                new AwsError({
                  operation: "ec2:RunInstances",
                  message: "no instance returned",
                }),
              )
            return Effect.succeed({ instanceId: inst.InstanceId })
          }),
          Effect.mapError((e) =>
            e instanceof AwsError ? e : awsError("ec2:RunInstances")(e),
          ),
        )
    }

    const describeInstances = (input: DescribeInstancesInput) => {
      const filters: { name: string; values: ReadonlyArray<string> }[] = []
      for (const tf of input.tagFilters ?? []) {
        filters.push({ name: `tag:${tf.key}`, values: tf.values })
      }
      if (input.states && input.states.length > 0) {
        filters.push({ name: "instance-state-name", values: input.states })
      }
      const args: string[] = [
        "ec2",
        "describe-instances",
        "--region",
        input.region,
        ...filterArg(filters),
      ]
      if (input.instanceIds && input.instanceIds.length > 0) {
        args.push("--instance-ids", ...input.instanceIds)
      }
      args.push("--output", "json")
      return sub
        .runJson<{
          Reservations: ReadonlyArray<{
            Instances: ReadonlyArray<{
              InstanceId: string
              ImageId: string
              InstanceType: string
              LaunchTime?: string
              PublicIpAddress?: string
              PrivateIpAddress?: string
              State?: { Name?: string }
              StateReason?: { Message?: string }
              SpotInstanceRequestId?: string
              Tags?: ReadonlyArray<{ Key?: string; Value?: string }>
            }>
          }>
        }>("aws", args)
        .pipe(
          Effect.map((r) =>
            (r.Reservations ?? []).flatMap((res) =>
              (res.Instances ?? []).map<Ec2Instance>((i) => ({
                instanceId: i.InstanceId,
                state: i.State?.Name ?? "unknown",
                instanceType: i.InstanceType,
                launchTime: i.LaunchTime,
                publicIp: i.PublicIpAddress,
                privateIp: i.PrivateIpAddress,
                imageId: i.ImageId,
                tags: parseTags(i.Tags),
                spotInstanceRequestId: i.SpotInstanceRequestId,
                stateReason: i.StateReason?.Message,
              })),
            ),
          ),
          Effect.mapError(awsError("ec2:DescribeInstances")),
        )
    }

    const terminateInstances = (region: string, instanceIds: ReadonlyArray<string>) =>
      instanceIds.length === 0
        ? Effect.void
        : sub
            .run("aws", [
              "ec2",
              "terminate-instances",
              "--region",
              region,
              "--instance-ids",
              ...instanceIds,
              "--output",
              "json",
            ])
            .pipe(
              Effect.asVoid,
              Effect.mapError(awsError("ec2:TerminateInstances")),
            )

    const waitForInstance = (
      region: string,
      instanceId: string,
      state: "running" | "stopped" | "terminated",
    ) =>
      sub
        .run("aws", [
          "ec2",
          "wait",
          `instance-${state}`,
          "--region",
          region,
          "--instance-ids",
          instanceId,
        ])
        .pipe(
          Effect.asVoid,
          Effect.mapError(awsError(`ec2:wait instance-${state}`)),
        )

    const describeImages = (input: DescribeImagesInput) => {
      const args: string[] = ["ec2", "describe-images", "--region", input.region]
      if (input.owners && input.owners.length > 0) {
        args.push("--owners", ...input.owners)
      }
      const filters: { name: string; values: ReadonlyArray<string> }[] = []
      for (const tf of input.tagFilters ?? []) {
        filters.push({ name: `tag:${tf.key}`, values: tf.values })
      }
      args.push(...filterArg(filters))
      if (input.imageIds && input.imageIds.length > 0) {
        args.push("--image-ids", ...input.imageIds)
      }
      args.push("--output", "json")
      return sub
        .runJson<{
          Images: ReadonlyArray<{
            ImageId: string
            Name?: string
            CreationDate?: string
            State?: string
            Tags?: ReadonlyArray<{ Key?: string; Value?: string }>
          }>
        }>("aws", args)
        .pipe(
          Effect.map((r) =>
            (r.Images ?? []).map<Ec2Image>((img) => ({
              imageId: img.ImageId,
              name: img.Name,
              creationDate: img.CreationDate,
              state: img.State ?? "unknown",
              tags: parseTags(img.Tags),
            })),
          ),
          Effect.mapError(awsError("ec2:DescribeImages")),
        )
    }

    const createImage = (input: CreateImageInput) => {
      const tagSpec = [
        {
          ResourceType: "image",
          Tags: input.tags.map((t) => ({ Key: t.key, Value: t.value })),
        },
        {
          ResourceType: "snapshot",
          Tags: input.tags.map((t) => ({ Key: t.key, Value: t.value })),
        },
      ]
      const args: string[] = [
        "ec2",
        "create-image",
        "--region",
        input.region,
        "--instance-id",
        input.instanceId,
        "--name",
        input.name,
        "--tag-specifications",
        JSON.stringify(tagSpec),
        "--output",
        "json",
      ]
      if (input.description) args.push("--description", input.description)
      if (input.noReboot) args.push("--no-reboot")
      return sub
        .runJson<{ ImageId: string }>("aws", args)
        .pipe(
          Effect.map((r) => ({ imageId: r.ImageId })),
          Effect.mapError(awsError("ec2:CreateImage")),
        )
    }

    const waitForImage = (region: string, imageId: string) =>
      sub
        .run("aws", [
          "ec2",
          "wait",
          "image-available",
          "--region",
          region,
          "--image-ids",
          imageId,
        ])
        .pipe(
          Effect.asVoid,
          Effect.mapError(awsError("ec2:wait image-available")),
        )

    const deregisterImage = (region: string, imageId: string) =>
      sub
        .run("aws", [
          "ec2",
          "deregister-image",
          "--region",
          region,
          "--image-id",
          imageId,
          "--output",
          "json",
        ])
        .pipe(
          Effect.asVoid,
          Effect.mapError(awsError("ec2:DeregisterImage")),
        )

    return Ec2.of({
      findVpcIdByName,
      findSubnetIdsByVpcId,
      findSecurityGroupIdByName,
      findLatestAmazonLinuxAmi,
      runInstance,
      describeInstances,
      terminateInstances,
      waitForInstance,
      describeImages,
      createImage,
      waitForImage,
      deregisterImage,
    })
  }),
)
