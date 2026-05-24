import { Effect, Layer } from "effect"
import { CloudflareError, ConfigError, UserError } from "../../infra/Errors.ts"
import { ConfigService } from "../../services/ConfigService.ts"
import { Team } from "../../services/backend/Team.ts"
import type { AddMemberResult } from "../../services/backend/Team.ts"
import type { TeamMember } from "../../schema/TeamMember.ts"
import { cfAuthHeaders } from "./cfAuth.ts"

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

export const CloudflareTeamLive = Layer.effect(
  Team,
  Effect.gen(function* () {
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
        ).pipe(
          // Creating a service token fails with `not_enabled` until the account
          // has turned on Cloudflare Access — a one-time Zero Trust setup the
          // raw API blob doesn't explain.
          Effect.catchTag("CloudflareError", (e): Effect.Effect<never, UserError | CloudflareError> =>
            e.message.includes("not_enabled")
              ? Effect.fail(
                  new UserError({
                    message:
                      "Cloudflare Access is not enabled on this account, so service tokens cannot be created.",
                    hint: "Enable Zero Trust Access (pick a team domain) at https://one.dash.cloudflare.com, then retry `afk team add`.",
                  }),
                )
              : Effect.fail(e),
          ),
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

    return Team.of({
      add: ({ name }) => addCf(name),
      ls: lsCf,
      rm: rmCf,
    })
  }),
)
