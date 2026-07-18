import { Context, Effect, Layer } from "effect"
import { Subprocess } from "../../infra/Subprocess.ts"
import { AwsError } from "../../infra/Errors.ts"
import { makeAwsCli } from "./awsCli.ts"

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
  /**
   * What `shutdown -h now` inside the instance does. "terminate" reclaims the
   * instance (and EBS) on exit; "stop" preserves the EBS root volume so the Run
   * can be retained and resumed. Spot must be "terminate".
   */
  readonly shutdownBehavior: "stop" | "terminate"
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
  /**
   * Free-form transition note from EC2, e.g.
   * `"User initiated (2026-06-28 14:00:00 GMT)"` on a stopped instance. The
   * parenthesised timestamp is the only signal DescribeInstances gives for when
   * an instance stopped — used to date a retained Run's reclamation window.
   */
  readonly stateTransitionReason?: string
}

export interface Ec2Image {
  readonly imageId: string
  readonly name?: string
  readonly creationDate?: string
  readonly state: string
  readonly tags: ReadonlyArray<Tag>
  /** EBS snapshot ids backing this AMI's block device mappings. */
  readonly snapshotIds: ReadonlyArray<string>
}

export interface DescribeInstancesInput {
  readonly region: string
  readonly tagFilters?: ReadonlyArray<{
    key: string
    values: ReadonlyArray<string>
  }>
  readonly instanceIds?: ReadonlyArray<string>
  readonly states?: ReadonlyArray<string>
}

export interface DescribeImagesInput {
  readonly region: string
  readonly owners?: ReadonlyArray<string>
  readonly tagFilters?: ReadonlyArray<{
    key: string
    values: ReadonlyArray<string>
  }>
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

const parseTags = (
  raw: ReadonlyArray<{ Key?: string; Value?: string }> | undefined,
): Tag[] =>
  (raw ?? [])
    .filter(
      (t): t is { Key: string; Value: string } =>
        !!t.Key && t.Value !== undefined,
    )
    .map((t) => ({ key: t.Key, value: t.Value }))

const tagsCli = (tags: ReadonlyArray<Tag>): string =>
  tags.map((t) => `Key=${t.key},Value=${t.value}`).join(" ")

const filterArg = (
  filters: ReadonlyArray<{ name: string; values: ReadonlyArray<string> }>,
): string[] => {
  if (filters.length === 0) return []
  return [
    "--filters",
    ...filters.map((f) => `Name=${f.name},Values=${f.values.join(",")}`),
  ]
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
    /** Start stopped instances (resume a retained Run). */
    readonly startInstances: (
      region: string,
      instanceIds: ReadonlyArray<string>,
    ) => Effect.Effect<void, AwsError>
    /** Stop running instances, preserving EBS (re-park a retained Run). */
    readonly stopInstances: (
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
    /** Delete an EBS snapshot. No-op-safe if already gone. */
    readonly deleteSnapshot: (
      region: string,
      snapshotId: string,
    ) => Effect.Effect<void, AwsError>
  }
>() {}

export const Ec2Live = Layer.effect(
  Ec2,
  Effect.gen(function* () {
    const sub = yield* Subprocess
    const aws = makeAwsCli(sub)

    const findVpcIdByName = (region: string, vpcName: string) =>
      aws
        .json<{ Vpcs: ReadonlyArray<{ VpcId: string }> }>("ec2:DescribeVpcs", [
          "ec2",
          "describe-vpcs",
          "--region",
          region,
          "--filters",
          `Name=tag:Name,Values=${vpcName}`,
        ])
        .pipe(
          Effect.flatMap((r) => {
            const vpc = r.Vpcs[0]
            return vpc
              ? Effect.succeed(vpc.VpcId)
              : Effect.fail(
                  new AwsError({
                    operation: "ec2:DescribeVpcs",
                    message: `VPC '${vpcName}' not found in ${region}`,
                  }),
                )
          }),
        )

    const findSubnetIdsByVpcId = (region: string, vpcId: string) =>
      aws
        .json<{ Subnets: ReadonlyArray<{ SubnetId: string }> }>(
          "ec2:DescribeSubnets",
          [
            "ec2",
            "describe-subnets",
            "--region",
            region,
            "--filters",
            `Name=vpc-id,Values=${vpcId}`,
          ],
        )
        .pipe(Effect.map((r) => r.Subnets.map((s) => s.SubnetId)))

    const findSecurityGroupIdByName = (
      region: string,
      vpcId: string,
      sgName: string,
    ) =>
      aws
        .json<{ SecurityGroups: ReadonlyArray<{ GroupId: string }> }>(
          "ec2:DescribeSecurityGroups",
          [
            "ec2",
            "describe-security-groups",
            "--region",
            region,
            "--filters",
            `Name=vpc-id,Values=${vpcId}`,
            `Name=group-name,Values=${sgName}`,
          ],
        )
        .pipe(
          Effect.flatMap((r) => {
            const sg = r.SecurityGroups[0]
            return sg
              ? Effect.succeed(sg.GroupId)
              : Effect.fail(
                  new AwsError({
                    operation: "ec2:DescribeSecurityGroups",
                    message: `security group '${sgName}' not found in VPC '${vpcId}'`,
                  }),
                )
          }),
        )

    // SSM public parameter that always points at the latest AL2023 x86_64 AMI.
    const findLatestAmazonLinuxAmi = (region: string) =>
      aws
        .json<{ Parameter: { Value: string } }>("ssm:GetParameter", [
          "ssm",
          "get-parameter",
          "--region",
          region,
          "--name",
          "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64",
        ])
        .pipe(Effect.map((r) => r.Parameter.Value))

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
        input.shutdownBehavior,
        "--metadata-options",
        "HttpTokens=required,HttpEndpoint=enabled,InstanceMetadataTags=enabled",
        "--tag-specifications",
        JSON.stringify(tagSpec),
        "--count",
        "1",
        "--associate-public-ip-address",
      ]
      if (input.spot) {
        args.push(
          "--instance-market-options",
          JSON.stringify({
            MarketType: "spot",
            SpotOptions: {
              SpotInstanceType: "one-time",
              InstanceInterruptionBehavior: "terminate",
            },
          }),
        )
      }
      return aws
        .json<{ Instances: ReadonlyArray<{ InstanceId: string }> }>(
          "ec2:RunInstances",
          args,
        )
        .pipe(
          Effect.flatMap((r) => {
            const inst = r.Instances[0]
            return inst
              ? Effect.succeed({ instanceId: inst.InstanceId })
              : Effect.fail(
                  new AwsError({
                    operation: "ec2:RunInstances",
                    message: "no instance returned",
                  }),
                )
          }),
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
      return aws
        .json<{
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
              StateTransitionReason?: string
              SpotInstanceRequestId?: string
              Tags?: ReadonlyArray<{ Key?: string; Value?: string }>
            }>
          }>
        }>("ec2:DescribeInstances", args)
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
                stateTransitionReason: i.StateTransitionReason,
              })),
            ),
          ),
        )
    }

    const terminateInstances = (
      region: string,
      instanceIds: ReadonlyArray<string>,
    ) =>
      instanceIds.length === 0
        ? Effect.void
        : aws.run("ec2:TerminateInstances", [
            "ec2",
            "terminate-instances",
            "--region",
            region,
            "--instance-ids",
            ...instanceIds,
          ])

    const startInstances = (
      region: string,
      instanceIds: ReadonlyArray<string>,
    ) =>
      instanceIds.length === 0
        ? Effect.void
        : aws.run("ec2:StartInstances", [
            "ec2",
            "start-instances",
            "--region",
            region,
            "--instance-ids",
            ...instanceIds,
          ])

    const stopInstances = (
      region: string,
      instanceIds: ReadonlyArray<string>,
    ) =>
      instanceIds.length === 0
        ? Effect.void
        : aws.run("ec2:StopInstances", [
            "ec2",
            "stop-instances",
            "--region",
            region,
            "--instance-ids",
            ...instanceIds,
          ])

    const waitForInstance = (
      region: string,
      instanceId: string,
      state: "running" | "stopped" | "terminated",
    ) =>
      aws.run(`ec2:wait instance-${state}`, [
        "ec2",
        "wait",
        `instance-${state}`,
        "--region",
        region,
        "--instance-ids",
        instanceId,
      ])

    const describeImages = (input: DescribeImagesInput) => {
      const args: string[] = [
        "ec2",
        "describe-images",
        "--region",
        input.region,
      ]
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
      return aws
        .json<{
          Images: ReadonlyArray<{
            ImageId: string
            Name?: string
            CreationDate?: string
            State?: string
            Tags?: ReadonlyArray<{ Key?: string; Value?: string }>
            BlockDeviceMappings?: ReadonlyArray<{
              Ebs?: { SnapshotId?: string }
            }>
          }>
        }>("ec2:DescribeImages", args)
        .pipe(
          Effect.map((r) =>
            (r.Images ?? []).map<Ec2Image>((img) => ({
              imageId: img.ImageId,
              name: img.Name,
              creationDate: img.CreationDate,
              state: img.State ?? "unknown",
              tags: parseTags(img.Tags),
              snapshotIds: (img.BlockDeviceMappings ?? [])
                .map((m) => m.Ebs?.SnapshotId)
                .filter((s): s is string => !!s),
            })),
          ),
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
      ]
      if (input.description) args.push("--description", input.description)
      if (input.noReboot) args.push("--no-reboot")
      return aws
        .json<{ ImageId: string }>("ec2:CreateImage", args)
        .pipe(Effect.map((r) => ({ imageId: r.ImageId })))
    }

    const waitForImage = (region: string, imageId: string) =>
      aws.run("ec2:wait image-available", [
        "ec2",
        "wait",
        "image-available",
        "--region",
        region,
        "--image-ids",
        imageId,
      ])

    const deregisterImage = (region: string, imageId: string) =>
      aws.run("ec2:DeregisterImage", [
        "ec2",
        "deregister-image",
        "--region",
        region,
        "--image-id",
        imageId,
      ])

    const deleteSnapshot = (region: string, snapshotId: string) =>
      aws
        .run("ec2:DeleteSnapshot", [
          "ec2",
          "delete-snapshot",
          "--region",
          region,
          "--snapshot-id",
          snapshotId,
        ])
        .pipe(
          Effect.catchAll((e) =>
            e.message.includes("InvalidSnapshot.NotFound")
              ? Effect.void
              : Effect.fail(e),
          ),
        )

    return Ec2.of({
      findVpcIdByName,
      findSubnetIdsByVpcId,
      findSecurityGroupIdByName,
      findLatestAmazonLinuxAmi,
      runInstance,
      describeInstances,
      terminateInstances,
      startInstances,
      stopInstances,
      waitForInstance,
      describeImages,
      createImage,
      waitForImage,
      deregisterImage,
      deleteSnapshot,
    })
  }),
)
