import { Context, Effect, Layer } from "effect"
import { Subprocess } from "../../infra/Subprocess.ts"
import { AzureError } from "../../infra/Errors.ts"
import { makeAzCli } from "./azCli.ts"

/** The signed-in `az` principal, as `az account show` reports it. */
export interface AzAccount {
  readonly subscriptionId: string
  readonly tenantId: string
  /** A user's UPN, or a service principal's appId. */
  readonly userName: string
  readonly userType: "user" | "servicePrincipal"
}

/**
 * Azure caller identity adapter. The [[owner]] on the Azure Backend is the
 * signed-in `az` principal — a user's UPN or a service principal's appId — the
 * analogue of the gcloud account on GCP. Also resolves the principal's Entra
 * object id, which RBAC role assignments are made against.
 */
export class AzAuth extends Context.Tag("AzAuth")<
  AzAuth,
  {
    readonly account: Effect.Effect<AzAccount, AzureError>
    /** The caller's Microsoft Entra object id (user or service principal). */
    readonly objectId: Effect.Effect<string, AzureError>
  }
>() {}

export const AzAuthLive = Layer.effect(
  AzAuth,
  Effect.gen(function* () {
    const sub = yield* Subprocess
    const az = makeAzCli(sub)

    const account = az
      .json<{
        readonly id?: string
        readonly tenantId?: string
        readonly user?: { readonly name?: string; readonly type?: string }
      }>("account:show", ["account", "show"])
      .pipe(
        Effect.flatMap((a) =>
          a.id && a.user?.name
            ? Effect.succeed<AzAccount>({
                subscriptionId: a.id,
                tenantId: a.tenantId ?? "",
                userName: a.user.name,
                userType:
                  a.user.type === "servicePrincipal"
                    ? "servicePrincipal"
                    : "user",
              })
            : Effect.fail(
                new AzureError({
                  operation: "account:show",
                  message: "no signed-in az account — run `az login`",
                }),
              ),
        ),
      )

    const objectId = account.pipe(
      Effect.flatMap((a) =>
        a.userType === "servicePrincipal"
          ? az.text("ad:sp:show", [
              "ad",
              "sp",
              "show",
              "--id",
              a.userName,
              "--query",
              "id",
            ])
          : az.text("ad:signed-in-user:show", [
              "ad",
              "signed-in-user",
              "show",
              "--query",
              "id",
            ]),
      ),
    )

    return AzAuth.of({ account, objectId })
  }),
)
