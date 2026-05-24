import { Context, Effect, Layer } from "effect"
import { Subprocess } from "../../infra/Subprocess.ts"
import { AwsError } from "../../infra/Errors.ts"
import { makeAwsCli } from "./awsCli.ts"

export interface IamUser {
  readonly userName: string
  readonly arn: string
  readonly createDate?: string
}

export interface AccessKey {
  readonly accessKeyId: string
  readonly secretAccessKey: string
}

export class Iam extends Context.Tag("Iam")<
  Iam,
  {
    readonly createUser: (userName: string) => Effect.Effect<IamUser, AwsError>
    readonly deleteUser: (userName: string) => Effect.Effect<void, AwsError>
    readonly attachUserPolicy: (
      userName: string,
      policyArn: string,
    ) => Effect.Effect<void, AwsError>
    readonly detachUserPolicy: (
      userName: string,
      policyArn: string,
    ) => Effect.Effect<void, AwsError>
    readonly createAccessKey: (
      userName: string,
    ) => Effect.Effect<AccessKey, AwsError>
    readonly listAccessKeys: (
      userName: string,
    ) => Effect.Effect<ReadonlyArray<string>, AwsError>
    readonly deleteAccessKey: (
      userName: string,
      accessKeyId: string,
    ) => Effect.Effect<void, AwsError>
    readonly listUsersByPathPrefix: (
      prefix: string,
    ) => Effect.Effect<ReadonlyArray<IamUser>, AwsError>
    readonly tagUser: (
      userName: string,
      tags: ReadonlyArray<{ Key: string; Value: string }>,
    ) => Effect.Effect<void, AwsError>
    readonly getRole: (
      roleName: string,
    ) => Effect.Effect<
      { readonly arn: string; readonly assumeRolePolicy: unknown },
      AwsError
    >
    readonly updateAssumeRolePolicy: (
      roleName: string,
      policy: unknown,
    ) => Effect.Effect<void, AwsError>
    readonly getPolicyArn: (
      policyName: string,
    ) => Effect.Effect<string, AwsError>
  }
>() {}

export const IamLive = Layer.effect(
  Iam,
  Effect.gen(function* () {
    const sub = yield* Subprocess
    const aws = makeAwsCli(sub)

    return Iam.of({
      createUser: (userName) =>
        aws
          .json<{
            User: { UserName: string; Arn: string; CreateDate: string }
          }>("iam:CreateUser", [
            "iam",
            "create-user",
            "--user-name",
            userName,
            "--path",
            "/afk/",
          ])
          .pipe(
            Effect.map((r) => ({
              userName: r.User.UserName,
              arn: r.User.Arn,
              createDate: r.User.CreateDate,
            })),
          ),
      deleteUser: (userName) =>
        aws.run("iam:DeleteUser", [
          "iam",
          "delete-user",
          "--user-name",
          userName,
        ]),
      attachUserPolicy: (userName, policyArn) =>
        aws.run("iam:AttachUserPolicy", [
          "iam",
          "attach-user-policy",
          "--user-name",
          userName,
          "--policy-arn",
          policyArn,
        ]),
      detachUserPolicy: (userName, policyArn) =>
        aws.run("iam:DetachUserPolicy", [
          "iam",
          "detach-user-policy",
          "--user-name",
          userName,
          "--policy-arn",
          policyArn,
        ]),
      createAccessKey: (userName) =>
        aws
          .json<{
            AccessKey: { AccessKeyId: string; SecretAccessKey: string }
          }>("iam:CreateAccessKey", [
            "iam",
            "create-access-key",
            "--user-name",
            userName,
          ])
          .pipe(
            Effect.map((r) => ({
              accessKeyId: r.AccessKey.AccessKeyId,
              secretAccessKey: r.AccessKey.SecretAccessKey,
            })),
          ),
      listAccessKeys: (userName) =>
        aws
          .json<{
            AccessKeyMetadata: ReadonlyArray<{ AccessKeyId: string }>
          }>("iam:ListAccessKeys", [
            "iam",
            "list-access-keys",
            "--user-name",
            userName,
          ])
          .pipe(
            Effect.map((r) => r.AccessKeyMetadata.map((k) => k.AccessKeyId)),
          ),
      deleteAccessKey: (userName, accessKeyId) =>
        aws.run("iam:DeleteAccessKey", [
          "iam",
          "delete-access-key",
          "--user-name",
          userName,
          "--access-key-id",
          accessKeyId,
        ]),
      listUsersByPathPrefix: (prefix) =>
        aws
          .json<{
            Users: ReadonlyArray<{
              UserName: string
              Arn: string
              CreateDate?: string
            }>
          }>("iam:ListUsers", ["iam", "list-users", "--path-prefix", prefix])
          .pipe(
            Effect.map((r) =>
              r.Users.map<IamUser>((u) => ({
                userName: u.UserName,
                arn: u.Arn,
                createDate: u.CreateDate,
              })),
            ),
          ),
      tagUser: (userName, tags) =>
        aws.run("iam:TagUser", [
          "iam",
          "tag-user",
          "--user-name",
          userName,
          "--tags",
          ...tags.map((t) => `Key=${t.Key},Value=${t.Value}`),
        ]),
      getRole: (roleName) =>
        aws
          .json<{
            Role: { Arn: string; AssumeRolePolicyDocument: unknown }
          }>("iam:GetRole", ["iam", "get-role", "--role-name", roleName])
          .pipe(
            Effect.map((r) => ({
              arn: r.Role.Arn,
              assumeRolePolicy: r.Role.AssumeRolePolicyDocument,
            })),
          ),
      updateAssumeRolePolicy: (roleName, policy) =>
        aws.run("iam:UpdateAssumeRolePolicy", [
          "iam",
          "update-assume-role-policy",
          "--role-name",
          roleName,
          "--policy-document",
          JSON.stringify(policy),
        ]),
      getPolicyArn: (policyName) =>
        aws
          .json<{
            Policies: ReadonlyArray<{ PolicyName: string; Arn: string }>
          }>("iam:ListPolicies", [
            "iam",
            "list-policies",
            "--scope",
            "Local",
            "--query",
            `Policies[?PolicyName=='${policyName}']`,
          ])
          .pipe(
            Effect.flatMap((r) => {
              const first = r.Policies[0]
              return first
                ? Effect.succeed(first.Arn)
                : Effect.fail(
                    new AwsError({
                      operation: "iam:ListPolicies",
                      message: `policy '${policyName}' not found`,
                    }),
                  )
            }),
          ),
    })
  }),
)
