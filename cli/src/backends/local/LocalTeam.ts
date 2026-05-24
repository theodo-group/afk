import { Effect, Layer } from "effect"
import { userInfo } from "node:os"
import { Team } from "../../services/backend/Team.ts"
import { UserError } from "../../infra/Errors.ts"
import type { TeamMember } from "../../schema/TeamMember.ts"
import { LOCAL_OWNER_ID } from "../../constants.ts"

/**
 * Local implementation of Team. A single-machine Backend has no multi-tenant
 * identity to scope against — every Run is "yours" and there is no one to add
 * to a team (see CONTEXT.md "Owner"). `ls` reflects the one local principal;
 * `add`/`rm` fail with a UserError pointing at the cloud Backends, rather than
 * faking a membership surface that can't gate anything.
 */
const unsupported = (verb: string) =>
  Effect.fail(
    new UserError({
      message: `team ${verb} is not supported on the Local Backend.`,
      hint: "Membership is a cloud concept — use the AWS or Cloudflare Backend for multi-developer access control.",
    }),
  )

export const LocalTeamLive = Layer.succeed(
  Team,
  Team.of({
    add: () => unsupported("add"),
    rm: () => unsupported("rm"),
    ls: Effect.sync(
      (): ReadonlyArray<TeamMember> => [
        {
          name: (() => {
            try {
              return userInfo().username
            } catch {
              return LOCAL_OWNER_ID
            }
          })(),
          kind: "trusted-principal",
          arn: LOCAL_OWNER_ID,
        },
      ],
    ),
  }),
)
