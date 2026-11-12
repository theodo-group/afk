import { Effect, Layer } from "effect"
import { AzRbac } from "../../adapters/azure/AzRbac.ts"
import { AzAuth } from "../../adapters/azure/AzAuth.ts"
import { ConfigService } from "../../services/ConfigService.ts"
import { UserError } from "../../infra/Errors.ts"
import { Team } from "../../services/backend/Team.ts"
import type { TeamMember } from "../../schema/TeamMember.ts"
import { makeResolveAzureCoords } from "./azureCoords.ts"

/**
 * Built-in role granted beside the custom afk-developer role: Entra ID SSH
 * sign-in with sudo, which `afk attach` needs to reach Docker on the VM.
 * Mirrors terraform's `developer_vm_login` assignment.
 */
export const AZURE_VM_LOGIN_ROLE = "Virtual Machine Administrator Login"

/**
 * Azure implementation of Team. Like GCP, the Azure Backend never *creates*
 * principals: `add` assigns an existing Entra user, group or service principal
 * (anything `az role assignment create --assignee` resolves — a UPN, an object
 * id, an appId) the two roles Terraform grants the founding developer, scoped
 * to the afk resource group.
 */
export const AzureTeamLive = Layer.effect(
  Team,
  Effect.gen(function* () {
    const rbac = yield* AzRbac
    const auth = yield* AzAuth
    const cfg = yield* ConfigService
    const coords = makeResolveAzureCoords(cfg, auth)

    const roles = (developerRole: string) => [
      developerRole,
      AZURE_VM_LOGIN_ROLE,
    ]

    const ls = Effect.gen(function* () {
      const { names } = yield* coords
      const assignments = yield* rbac.list(names.scope, names.developerRole)
      return assignments.map<TeamMember>((a) => ({
        name: a.principalName,
        kind: "azure-principal",
        arn: a.principalId,
      }))
    })

    const add = ({ name, principal }: { name: string; principal?: string }) =>
      Effect.gen(function* () {
        if (!principal) {
          return yield* Effect.fail(
            new UserError({
              message:
                "Azure team membership assigns roles to an existing principal — pass one as the second argument.",
              hint: "e.g. `afk team add dev dev@acme.com` (a UPN, an object id or an appId; Azure does not create principals).",
            }),
          )
        }
        const { names } = yield* coords
        yield* Effect.forEach(roles(names.developerRole), (role) =>
          rbac.assign(names.scope, principal, role),
        )
        return {
          member: { name, kind: "azure-principal" as const, arn: principal },
        }
      })

    const rm = (name: string) =>
      Effect.gen(function* () {
        const { names } = yield* coords
        const members = yield* ls
        // Match the object id, the resolved name, or its local part, so
        // `afk team rm dev` works as well as the full UPN.
        const match = members.find(
          (m) =>
            m.arn === name || m.name === name || m.name.split("@")[0] === name,
        )
        if (!match) {
          return yield* Effect.fail(
            new UserError({
              message: `team member '${name}' not found`,
              hint: "Use `afk team ls` to see members.",
            }),
          )
        }
        yield* Effect.forEach(roles(names.developerRole), (role) =>
          rbac.unassign(names.scope, match.arn, role),
        )
      })

    return Team.of({ add, ls, rm })
  }),
)
