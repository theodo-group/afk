import { Context, Effect, Layer } from "effect"
import { Subprocess } from "../../infra/Subprocess.ts"
import { AzureError } from "../../infra/Errors.ts"
import { makeAzCli } from "./azCli.ts"

export interface RoleAssignment {
  readonly principalId: string
  /** The UPN / app display name Azure resolves for the principal, if any. */
  readonly principalName: string
  readonly principalType: string
  readonly roleName: string
}

/**
 * Azure RBAC adapter — the analogue of `GcpIam`: role assignments at one
 * scope (the afk resource group). Principals are referenced by object id, or
 * anything `az role assignment create --assignee` resolves (a UPN, an appId).
 */
export class AzRbac extends Context.Tag("AzRbac")<
  AzRbac,
  {
    readonly list: (
      scope: string,
      roleName: string,
    ) => Effect.Effect<ReadonlyArray<RoleAssignment>, AzureError>
    readonly assign: (
      scope: string,
      assignee: string,
      roleName: string,
    ) => Effect.Effect<void, AzureError>
    readonly unassign: (
      scope: string,
      assignee: string,
      roleName: string,
    ) => Effect.Effect<void, AzureError>
  }
>() {}

export const AzRbacLive = Layer.effect(
  AzRbac,
  Effect.gen(function* () {
    const sub = yield* Subprocess
    const az = makeAzCli(sub)

    const list = (scope: string, roleName: string) =>
      az
        .json<
          ReadonlyArray<{
            readonly principalId?: string
            readonly principalName?: string
            readonly principalType?: string
            readonly roleDefinitionName?: string
          }>
        >("role:assignment:list", [
          "role",
          "assignment",
          "list",
          "--scope",
          scope,
          "--role",
          roleName,
        ])
        .pipe(
          Effect.map((rows) =>
            rows.map<RoleAssignment>((r) => ({
              principalId: r.principalId ?? "",
              principalName: r.principalName ?? r.principalId ?? "",
              principalType: r.principalType ?? "",
              roleName: r.roleDefinitionName ?? roleName,
            })),
          ),
        )

    const assignment =
      (verb: "create" | "delete") =>
      (scope: string, assignee: string, roleName: string) =>
        az.run(`role:assignment:${verb}`, [
          "role",
          "assignment",
          verb,
          "--scope",
          scope,
          "--assignee",
          assignee,
          "--role",
          roleName,
        ])

    return AzRbac.of({
      list,
      assign: assignment("create"),
      unassign: assignment("delete"),
    })
  }),
)
