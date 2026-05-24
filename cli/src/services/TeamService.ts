import { Context, Effect, Layer } from "effect"
import { Iam } from "../adapters/aws/Iam.ts"
import { Sts } from "../adapters/aws/Sts.ts"
import { Compute } from "./backend/Compute.ts"
import { ConfigService } from "./ConfigService.ts"
import { AwsError, CloudflareError, ConfigError, UserError } from "../infra/Errors.ts"
import { AFK_DEVELOPER_POLICY, AFK_DEVELOPER_ROLE } from "../constants.ts"
import type { TeamMember } from "../schema/TeamMember.ts"

export interface AddMemberResult {
  readonly member: TeamMember
  /** AWS-only: a new IAM-user access key, shown once. */
  readonly accessKey?: { readonly accessKeyId: string; readonly secretAccessKey: string }
  /** CF-only: a new Access service-token client credential, shown once. */
  readonly serviceToken?: {
    readonly clientId: string
    readonly clientSecret: string
  }
}

export class TeamService extends Context.Tag("TeamService")<
  TeamService,
  {
    readonly add: (input: {
      readonly name: string
      readonly principal?: string
    }) => Effect.Effect<AddMemberResult, AwsError | CloudflareError | UserError | ConfigError>
    readonly ls: Effect.Effect<
      ReadonlyArray<TeamMember>,
      AwsError | CloudflareError | UserError | ConfigError
    >
    readonly rm: (
      name: string,
    ) => Effect.Effect<void, AwsError | CloudflareError | UserError | ConfigError>
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

const cfAuthHeaders = (): Record<string, string> => {
  const id = process.env.AFK_CF_CLIENT_ID
  const secret = process.env.AFK_CF_CLIENT_SECRET
  const out: Record<string, string> = { "content-type": "application/json" }
  if (id) out["CF-Access-Client-Id"] = id
  if (secret) out["CF-Access-Client-Secret"] = secret
  return out
}

const cfCall = (
  operation: string,
  url: string,
  init?: RequestInit,
): Effect.Effect<unknown, CloudflareError> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(url, {
        ...init,
        headers: { ...cfAuthHeaders(), ...(init?.headers ?? {}) },
      })
      const text = await res.text()
      if (!res.ok) {
        throw new CloudflareError({
          operation,
          status: res.status,
          message: text || res.statusText,
        })
      }
      return text ? JSON.parse(text) : {}
    },
    catch: (e): CloudflareError =>
      e instanceof CloudflareError
        ? e
        : new CloudflareError({ operation, message: String(e) }),
  })

export const TeamServiceLive = Layer.effect(
  TeamService,
  Effect.gen(function* () {
    const iam = yield* Iam
    const sts = yield* Sts
    const compute = yield* Compute
    const cfg = yield* ConfigService

    const cfWorkerUrl = Effect.gen(function* () {
      const { config } = yield* cfg.load
      const url = config.cloudflare?.workerUrl
      if (!url) {
        return yield* Effect.fail(
          new UserError({
            message: "cloudflare.workerUrl is not set in afk.config.json.",
          }),
        )
      }
      return url.replace(/\/$/, "")
    })

    const lsCf: Effect.Effect<
      ReadonlyArray<TeamMember>,
      CloudflareError | UserError | ConfigError
    > = Effect.gen(function* () {
      const base = yield* cfWorkerUrl
      const out = (yield* cfCall("GET /team", `${base}/team`)) as {
        members: ReadonlyArray<{ name: string; clientId: string }>
      }
      return out.members.map<TeamMember>((m) => ({
        name: m.name,
        kind: "cf-service-token",
        arn: m.clientId,
      }))
    })

    const addCf = (name: string): Effect.Effect<
      AddMemberResult,
      CloudflareError | UserError | ConfigError
    > =>
      Effect.gen(function* () {
        const base = yield* cfWorkerUrl
        const created = (yield* cfCall(
          "POST /team/:name",
          `${base}/team/${encodeURIComponent(name)}`,
          { method: "POST" },
        )) as { name: string; clientId: string; clientSecret: string }
        return {
          member: {
            name: created.name,
            kind: "cf-service-token",
            arn: created.clientId,
          },
          serviceToken: {
            clientId: created.clientId,
            clientSecret: created.clientSecret,
          },
        }
      })

    const rmCf = (
      name: string,
    ): Effect.Effect<void, CloudflareError | UserError | ConfigError> =>
      Effect.gen(function* () {
        const base = yield* cfWorkerUrl
        // DELETE is keyed by clientId, not name — resolve it via ls first.
        const members = yield* lsCf
        const m = members.find((x) => x.name === name || x.arn === name)
        if (!m) {
          return yield* Effect.fail(
            new UserError({
              message: `team member '${name}' not found`,
              hint: "Use `afk team ls` to see members.",
            }),
          )
        }
        yield* cfCall(
          "DELETE /team/:name",
          `${base}/team/${encodeURIComponent(name)}`,
          {
            method: "DELETE",
            body: JSON.stringify({ clientId: m.arn, tokenId: m.arn }),
          },
        )
      })

    const lsAws = Effect.gen(function* () {
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

    const addAws = ({
      name,
      principal,
    }: {
      name: string
      principal?: string
    }): Effect.Effect<AddMemberResult, AwsError | UserError> =>
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
      })

    const rmAws = (name: string): Effect.Effect<void, AwsError | UserError> =>
      Effect.gen(function* () {
        const identity = yield* sts.callerIdentity
        const policyArn = `arn:aws:iam::${identity.Account}:policy/${AFK_DEVELOPER_POLICY}`
        const members = yield* lsAws
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
      })

    // AWS: IAM users / role trust policies.
    // Cloudflare: launcher Worker /team endpoints (CF Access service tokens).
    const isCloudflare = compute.backendName === "cloudflare"

    return TeamService.of({
      add: ({ name, principal }) =>
        isCloudflare ? addCf(name) : addAws({ name, principal }),
      ls: isCloudflare ? lsCf : lsAws,
      rm: (name) => (isCloudflare ? rmCf(name) : rmAws(name)),
    })
  }),
)
