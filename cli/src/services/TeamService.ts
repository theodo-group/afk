import { Context, Effect, Layer } from "effect"
import { Iam } from "../adapters/aws/Iam.ts"
import { Sts } from "../adapters/aws/Sts.ts"
import { AwsError, UserError } from "../infra/Errors.ts"
import { AFK_DEVELOPER_POLICY, AFK_DEVELOPER_ROLE } from "../constants.ts"
import type { TeamMember } from "../schema/TeamMember.ts"

export interface AddMemberResult {
  readonly member: TeamMember
  readonly accessKey?: { readonly accessKeyId: string; readonly secretAccessKey: string }
}

export class TeamService extends Context.Tag("TeamService")<
  TeamService,
  {
    readonly add: (input: {
      readonly name: string
      readonly principal?: string
    }) => Effect.Effect<AddMemberResult, AwsError | UserError>
    readonly ls: Effect.Effect<ReadonlyArray<TeamMember>, AwsError>
    readonly rm: (name: string) => Effect.Effect<void, AwsError | UserError>
  }
>() {}

interface AssumeRolePolicy {
  Statement: Array<{
    Effect: "Allow" | "Deny"
    Principal?: { AWS?: string | string[] }
    Action?: string | string[]
  }>
  Version?: string
}

const principalSet = (policy: AssumeRolePolicy): Set<string> => {
  const set = new Set<string>()
  for (const stmt of policy.Statement ?? []) {
    if (stmt.Effect !== "Allow") continue
    const aws = stmt.Principal?.AWS
    if (!aws) continue
    for (const p of Array.isArray(aws) ? aws : [aws]) set.add(p)
  }
  return set
}

const setAllPrincipals = (
  policy: AssumeRolePolicy,
  principals: ReadonlyArray<string>,
): AssumeRolePolicy => ({
  Version: policy.Version ?? "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Principal: { AWS: [...principals] },
      Action: "sts:AssumeRole",
    },
  ],
})

export const TeamServiceLive = Layer.effect(
  TeamService,
  Effect.gen(function* () {
    const iam = yield* Iam
    const sts = yield* Sts

    const ls = Effect.gen(function* () {
      const users = yield* iam.listUsersByPathPrefix("/afk/")
      const userMembers: TeamMember[] = users.map((u) => ({
        name: u.userName,
        kind: "iam-user",
        arn: u.arn,
        createdAt: u.createDate,
      }))
      const trustedMembers: TeamMember[] = yield* iam.getRole(AFK_DEVELOPER_ROLE).pipe(
        Effect.map((r) => {
          const principals = principalSet(r.assumeRolePolicy as AssumeRolePolicy)
          // Filter out the same-account "root" self-trust if present
          return [...principals]
            .filter((p) => !p.endsWith(":root"))
            .map<TeamMember>((arn) => ({
              name: arn.split("/").pop() ?? arn,
              kind: "trusted-principal",
              arn,
            }))
        }),
        Effect.catchAll(() => Effect.succeed([] as TeamMember[])),
      )
      return [...userMembers, ...trustedMembers]
    })

    return TeamService.of({
      add: ({ name, principal }) =>
        Effect.gen(function* () {
          const identity = yield* sts.callerIdentity
          const policyArn = `arn:aws:iam::${identity.Account}:policy/${AFK_DEVELOPER_POLICY}`

          if (principal) {
            const role = yield* iam.getRole(AFK_DEVELOPER_ROLE)
            const policy = role.assumeRolePolicy as AssumeRolePolicy
            const principals = principalSet(policy)
            principals.add(principal)
            yield* iam.updateAssumeRolePolicy(
              AFK_DEVELOPER_ROLE,
              setAllPrincipals(policy, [...principals]),
            )
            return {
              member: { name, kind: "trusted-principal", arn: principal },
            }
          }

          const user = yield* iam.createUser(name)
          yield* iam.attachUserPolicy(user.userName, policyArn)
          yield* iam.tagUser(user.userName, [
            { Key: "afk:managed", Value: "true" },
          ])
          const key = yield* iam.createAccessKey(user.userName)
          return {
            member: {
              name: user.userName,
              kind: "iam-user",
              arn: user.arn,
              createdAt: user.createDate,
            },
            accessKey: {
              accessKeyId: key.accessKeyId,
              secretAccessKey: key.secretAccessKey,
            },
          }
        }),
      ls,
      rm: (name) =>
        Effect.gen(function* () {
          const identity = yield* sts.callerIdentity
          const policyArn = `arn:aws:iam::${identity.Account}:policy/${AFK_DEVELOPER_POLICY}`
          const members = yield* ls
          const match = members.find((m) => m.name === name || m.arn === name)
          if (!match) {
            return yield* Effect.fail(
              new UserError({
                message: `team member '${name}' not found`,
                hint: "Use `afk team ls` to see members.",
              }),
            )
          }
          if (match.kind === "iam-user") {
            const keys = yield* iam.listAccessKeys(match.name)
            yield* Effect.forEach(keys, (k) =>
              iam.deleteAccessKey(match.name, k),
            )
            yield* iam
              .detachUserPolicy(match.name, policyArn)
              .pipe(Effect.catchAll(() => Effect.void))
            yield* iam.deleteUser(match.name)
          } else {
            const role = yield* iam.getRole(AFK_DEVELOPER_ROLE)
            const policy = role.assumeRolePolicy as AssumeRolePolicy
            const principals = principalSet(policy)
            principals.delete(match.arn)
            yield* iam.updateAssumeRolePolicy(
              AFK_DEVELOPER_ROLE,
              setAllPrincipals(policy, [...principals]),
            )
          }
        }),
    })
  }),
)
