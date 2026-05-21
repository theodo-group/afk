import { Context, Effect, Layer } from "effect"
import { Subprocess } from "../../infra/Subprocess.ts"
import { AwsError } from "../../infra/Errors.ts"

const awsError = (op: string) => (e: { _tag: string; stderr?: string; cause?: unknown }) =>
  new AwsError({
    operation: op,
    message: e._tag === "ParseError" ? String(e.cause) : (e.stderr ?? ""),
  })

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
    readonly createUser: (
      userName: string,
    ) => Effect.Effect<IamUser, AwsError>
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
    ) => Effect.Effect<{ readonly arn: string; readonly assumeRolePolicy: unknown }, AwsError>
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

    return Iam.of({
      createUser: (userName) =>
        sub
          .runJson<{ User: { UserName: string; Arn: string; CreateDate: string } }>(
            "aws",
            [
              "iam",
              "create-user",
              "--user-name",
              userName,
              "--path",
              "/afk/",
              "--output",
              "json",
            ],
          )
          .pipe(
            Effect.map((r) => ({
              userName: r.User.UserName,
              arn: r.User.Arn,
              createDate: r.User.CreateDate,
            })),
            Effect.mapError(awsError("iam:CreateUser")),
          ),
      deleteUser: (userName) =>
        sub
          .run("aws", ["iam", "delete-user", "--user-name", userName])
          .pipe(Effect.asVoid, Effect.mapError(awsError("iam:DeleteUser"))),
      attachUserPolicy: (userName, policyArn) =>
        sub
          .run("aws", [
            "iam",
            "attach-user-policy",
            "--user-name",
            userName,
            "--policy-arn",
            policyArn,
          ])
          .pipe(
            Effect.asVoid,
            Effect.mapError(awsError("iam:AttachUserPolicy")),
          ),
      detachUserPolicy: (userName, policyArn) =>
        sub
          .run("aws", [
            "iam",
            "detach-user-policy",
            "--user-name",
            userName,
            "--policy-arn",
            policyArn,
          ])
          .pipe(
            Effect.asVoid,
            Effect.mapError(awsError("iam:DetachUserPolicy")),
          ),
      createAccessKey: (userName) =>
        sub
          .runJson<{
            AccessKey: { AccessKeyId: string; SecretAccessKey: string }
          }>("aws", [
            "iam",
            "create-access-key",
            "--user-name",
            userName,
            "--output",
            "json",
          ])
          .pipe(
            Effect.map((r) => ({
              accessKeyId: r.AccessKey.AccessKeyId,
              secretAccessKey: r.AccessKey.SecretAccessKey,
            })),
            Effect.mapError(awsError("iam:CreateAccessKey")),
          ),
      listAccessKeys: (userName) =>
        sub
          .runJson<{
            AccessKeyMetadata: ReadonlyArray<{ AccessKeyId: string }>
          }>("aws", [
            "iam",
            "list-access-keys",
            "--user-name",
            userName,
            "--output",
            "json",
          ])
          .pipe(
            Effect.map((r) => r.AccessKeyMetadata.map((k) => k.AccessKeyId)),
            Effect.mapError(awsError("iam:ListAccessKeys")),
          ),
      deleteAccessKey: (userName, accessKeyId) =>
        sub
          .run("aws", [
            "iam",
            "delete-access-key",
            "--user-name",
            userName,
            "--access-key-id",
            accessKeyId,
          ])
          .pipe(
            Effect.asVoid,
            Effect.mapError(awsError("iam:DeleteAccessKey")),
          ),
      listUsersByPathPrefix: (prefix) =>
        sub
          .runJson<{
            Users: ReadonlyArray<{
              UserName: string
              Arn: string
              CreateDate?: string
            }>
          }>("aws", [
            "iam",
            "list-users",
            "--path-prefix",
            prefix,
            "--output",
            "json",
          ])
          .pipe(
            Effect.map((r) =>
              r.Users.map<IamUser>((u) => ({
                userName: u.UserName,
                arn: u.Arn,
                createDate: u.CreateDate,
              })),
            ),
            Effect.mapError(awsError("iam:ListUsers")),
          ),
      tagUser: (userName, tags) =>
        sub
          .run("aws", [
            "iam",
            "tag-user",
            "--user-name",
            userName,
            "--tags",
            ...tags.map((t) => `Key=${t.Key},Value=${t.Value}`),
          ])
          .pipe(Effect.asVoid, Effect.mapError(awsError("iam:TagUser"))),
      getRole: (roleName) =>
        sub
          .runJson<{
            Role: { Arn: string; AssumeRolePolicyDocument: unknown }
          }>("aws", [
            "iam",
            "get-role",
            "--role-name",
            roleName,
            "--output",
            "json",
          ])
          .pipe(
            Effect.map((r) => ({
              arn: r.Role.Arn,
              assumeRolePolicy: r.Role.AssumeRolePolicyDocument,
            })),
            Effect.mapError(awsError("iam:GetRole")),
          ),
      updateAssumeRolePolicy: (roleName, policy) =>
        sub
          .run("aws", [
            "iam",
            "update-assume-role-policy",
            "--role-name",
            roleName,
            "--policy-document",
            JSON.stringify(policy),
          ])
          .pipe(
            Effect.asVoid,
            Effect.mapError(awsError("iam:UpdateAssumeRolePolicy")),
          ),
      getPolicyArn: (policyName) =>
        sub
          .runJson<{
            Policies: ReadonlyArray<{ PolicyName: string; Arn: string }>
          }>("aws", [
            "iam",
            "list-policies",
            "--scope",
            "Local",
            "--query",
            `Policies[?PolicyName=='${policyName}']`,
            "--output",
            "json",
          ])
          .pipe(
            Effect.flatMap((r) => {
              const first = r.Policies[0]
              if (!first)
                return Effect.fail(
                  new AwsError({
                    operation: "iam:ListPolicies",
                    message: `policy '${policyName}' not found`,
                  }),
                )
              return Effect.succeed(first.Arn)
            }),
            Effect.mapError((e) =>
              e instanceof AwsError ? e : awsError("iam:ListPolicies")(e),
            ),
          ),
    })
  }),
)
