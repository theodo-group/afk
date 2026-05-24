import { Effect, Layer } from "effect"
import { CloudflareError, ConfigError, UserError } from "../../infra/Errors.ts"
import { Team } from "../../services/backend/Team.ts"
import type { AddMemberResult } from "../../services/backend/Team.ts"
import type { TeamMember } from "../../schema/TeamMember.ts"
import { CfWorker } from "./CfWorker.ts"

export const CloudflareTeamLive = Layer.effect(
  Team,
  Effect.gen(function* () {
    const worker = yield* CfWorker

    const lsCf: Effect.Effect<
      ReadonlyArray<TeamMember>,
      CloudflareError | UserError | ConfigError
    > = Effect.gen(function* () {
      const out = yield* worker.getJson<{
        members: ReadonlyArray<{ name: string; clientId: string }>
      }>("GET /team", "/team")
      return out.members.map<TeamMember>((m) => ({
        name: m.name,
        kind: "cf-service-token",
        arn: m.clientId,
      }))
    })

    const addCf = (
      name: string,
    ): Effect.Effect<
      AddMemberResult,
      CloudflareError | UserError | ConfigError
    > =>
      Effect.gen(function* () {
        const created = yield* worker
          .postJson<{ name: string; clientId: string; clientSecret: string }>(
            "POST /team/:name",
            `/team/${encodeURIComponent(name)}`,
          )
          .pipe(
            // Creating a service token fails with `not_enabled` until the account
            // has turned on Cloudflare Access — a one-time Zero Trust setup the
            // raw API blob doesn't explain.
            Effect.catchTag(
              "CloudflareError",
              (e): Effect.Effect<never, UserError | CloudflareError> =>
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
          )
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
        yield* worker.del(
          "DELETE /team/:name",
          `/team/${encodeURIComponent(name)}`,
          {
            clientId: m.arn,
            tokenId: m.arn,
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
