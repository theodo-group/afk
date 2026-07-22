import { Effect, Layer } from "effect"
import { GcpIam } from "../../adapters/gcp/Iam.ts"
import { Auth } from "../../adapters/gcp/Auth.ts"
import { ConfigService } from "../../services/ConfigService.ts"
import { ConfigError, GcpError, UserError } from "../../infra/Errors.ts"
import { GCP_DEVELOPER_ROLE, GCP_VM_SERVICE_ACCOUNT } from "../../constants.ts"
import { Team } from "../../services/backend/Team.ts"
import type { AddMemberResult } from "../../services/backend/Team.ts"
import type { TeamMember } from "../../schema/TeamMember.ts"

const roleId = (project: string) =>
  `projects/${project}/roles/${GCP_DEVELOPER_ROLE}`

// Predefined roles a developer needs alongside the custom afk-developer role:
// IAP SSH tunnel (`afk attach`) and OS Login (POSIX user on the VM). Neither is
// conditioned — mirrors terraform's `developer_iap_tunnel` / `developer_os_login`.
const PREDEFINED_DEVELOPER_ROLES = [
  "roles/iap.tunnelResourceAccessor",
  "roles/compute.osLogin",
] as const

const vmServiceAccount = (project: string): string =>
  `${GCP_VM_SERVICE_ACCOUNT}@${project}.iam.gserviceaccount.com`

// NOTE: the afk-developer binding is bound UNCONDITIONED. A machine-type/subnet
// IAM condition is not expressible for `compute.instances.create` — at create
// the requested machineType/subnet live in the request body, not in the
// binding's `resource.name` (which is the instance path), so any such condition
// evaluates false and blocks the create outright. Machine-type/subnet limits are
// enforced CLI-side (same as the owner/golden/managed label guards).

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

    const gcpProject = Effect.gen(function* () {
      const { config } = yield* cfg.load
      return config.gcp?.projectId ?? (yield* auth.activeProject)
    })

    const ls = Effect.gen(function* () {
      const p = yield* gcpProject
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
                "GCP team membership binds an existing principal — pass one as the second argument.",
              hint: "e.g. `afk team add dev user:dev@acme.com` (GCP does not create principals).",
            }),
          )
        }
        const p = yield* gcpProject
        // Reproduce the four bindings terraform grants the founding owner
        // (terraform/gcp/iam.tf), so a team-added member is fully functional.
        // 1. Custom afk-developer role, unconditioned (see NOTE above).
        yield* iam.addBinding(p, principal, roleId(p))
        // 2. actAs the afk-vm SA — required to pass it to Run instances.
        yield* iam.addServiceAccountBinding(
          p,
          vmServiceAccount(p),
          principal,
          "roles/iam.serviceAccountUser",
        )
        // 3-4. IAP tunnel (`afk attach`) + OS Login (SSH).
        yield* Effect.forEach(PREDEFINED_DEVELOPER_ROLES, (role) =>
          iam.addBinding(p, principal, role),
        )
        return {
          member: { name, kind: "gcp-principal", arn: principal },
        }
      })

    const rm = (
      name: string,
    ): Effect.Effect<void, GcpError | UserError | ConfigError> =>
      Effect.gen(function* () {
        const p = yield* gcpProject
        const members = yield* ls
        // Match on the full arn, the ls display name (the arn's identity, e.g.
        // dev@acme.com), or the local-part before '@' so `afk team rm dev` works
        // as well as the full email.
        const match = members.find(
          (m) =>
            m.name === name ||
            m.arn === name ||
            m.name.split("@")[0] === name,
        )
        if (!match) {
          return yield* Effect.fail(
            new UserError({
              message: `team member '${name}' not found`,
              hint: "Use `afk team ls` to see members.",
            }),
          )
        }
        // Unwind all four bindings `add` grants (symmetry with add above).
        yield* iam.removeBinding(p, match.arn, roleId(p))
        yield* iam.removeServiceAccountBinding(
          p,
          vmServiceAccount(p),
          match.arn,
          "roles/iam.serviceAccountUser",
        )
        yield* Effect.forEach(PREDEFINED_DEVELOPER_ROLES, (role) =>
          iam.removeBinding(p, match.arn, role),
        )
      })

    return Team.of({ add, ls, rm })
  }),
)
