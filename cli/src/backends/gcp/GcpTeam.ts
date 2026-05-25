import { Effect, Layer } from "effect"
import { GcpIam } from "../../adapters/gcp/Iam.ts"
import { Auth } from "../../adapters/gcp/Auth.ts"
import { ConfigService } from "../../services/ConfigService.ts"
import { ConfigError, GcpError, UserError } from "../../infra/Errors.ts"
import { GCP_DEVELOPER_ROLE } from "../../constants.ts"
import { Team } from "../../services/backend/Team.ts"
import type { AddMemberResult } from "../../services/backend/Team.ts"
import type { TeamMember } from "../../schema/TeamMember.ts"

const roleId = (project: string) =>
  `projects/${project}/roles/${GCP_DEVELOPER_ROLE}`

// The trailing identity of an IAM member binding (`user:a@b.com` → `a@b.com`).
const memberName = (member: string): string => member.split(":").pop() ?? member

/**
 * GCP implementation of Team. The GCP Backend never *creates* principals: it
 * binds/unbinds existing org members to the project-level `afkDeveloper` custom
 * role. `add` takes a `principal` (e.g. `user:dev@acme.com`); the `name` is the
 * display label. `AddMemberResult` reports the bound member — no access key or
 * service token, since nothing is minted.
 */
export const GcpTeamLive = Layer.effect(
  Team,
  Effect.gen(function* () {
    const iam = yield* GcpIam
    const auth = yield* Auth
    const cfg = yield* ConfigService

    const project = Effect.gen(function* () {
      const { config } = yield* cfg.load
      return config.gcp?.projectId ?? (yield* auth.activeProject)
    })

    const ls = Effect.gen(function* () {
      const p = yield* project
      const members = yield* iam.listBindings(p, roleId(p))
      return members.map<TeamMember>((m) => ({
        name: memberName(m),
        kind: "gcp-principal",
        arn: m,
      }))
    })

    const add = ({
      name,
      principal,
    }: {
      name: string
      principal?: string
    }): Effect.Effect<AddMemberResult, GcpError | UserError | ConfigError> =>
      Effect.gen(function* () {
        if (!principal) {
          return yield* Effect.fail(
            new UserError({
              message:
                "GCP team membership binds an existing principal — pass --principal.",
              hint: "e.g. `afk team add dev --principal user:dev@acme.com` (GCP does not create principals).",
            }),
          )
        }
        const p = yield* project
        yield* iam.addBinding(p, principal, roleId(p))
        return {
          member: { name, kind: "gcp-principal", arn: principal },
        }
      })

    const rm = (
      name: string,
    ): Effect.Effect<void, GcpError | UserError | ConfigError> =>
      Effect.gen(function* () {
        const p = yield* project
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
        yield* iam.removeBinding(p, match.arn, roleId(p))
      })

    return Team.of({ add, ls, rm })
  }),
)
