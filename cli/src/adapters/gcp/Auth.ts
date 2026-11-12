import { Context, Effect, Layer, Option } from "effect"
import { Subprocess } from "../../infra/Subprocess.ts"
import { GcpError } from "../../infra/Errors.ts"
import { makeGcloudCli } from "./gcloudCli.ts"

/**
 * GCP caller identity adapter. The Owner principal on the GCP Backend is the
 * authenticated `gcloud` account (a user or service-account email), the
 * analogue of the AWS STS UserId. Also resolves the active project + an access
 * token for the REST-only surfaces (Firestore).
 */
export class Auth extends Context.Tag("Auth")<
  Auth,
  {
    /** The active `gcloud` account email. */
    readonly callerAccount: Effect.Effect<string, GcpError>
    /** The active project id (`gcloud config get-value project`). */
    readonly activeProject: Effect.Effect<string, GcpError>
    /** A short-lived OAuth access token, for REST-only calls. */
    readonly accessToken: Effect.Effect<string, GcpError>
    /**
     * The caller's OS Login POSIX uid — the uid `afk attach` lands as over SSH,
     * which a Run's VM grants the Docker socket to. `None` where the caller has
     * no OS Login profile (a service-account Owner), which is a normal outcome:
     * such a Run is never attached to by hand.
     */
    readonly osLoginUid: Effect.Effect<Option.Option<string>, GcpError>
  }
>() {}

export const GcpAuthLive = Layer.effect(
  Auth,
  Effect.gen(function* () {
    const sub = yield* Subprocess
    const gcloud = makeGcloudCli(sub)

    const callerAccount = gcloud
      .json<ReadonlyArray<{ account: string }>>("auth:list", [
        "auth",
        "list",
        "--filter=status:ACTIVE",
      ])
      .pipe(
        Effect.flatMap((rows) => {
          const first = rows[0]
          return first
            ? Effect.succeed(first.account)
            : Effect.fail(
                new GcpError({
                  operation: "auth:list",
                  message: "no active gcloud account — run `gcloud auth login`",
                }),
              )
        }),
      )

    const activeProject = gcloud
      .text("config:get-value:project", ["config", "get-value", "project"])
      .pipe(
        Effect.flatMap((p) =>
          p && p !== "(unset)"
            ? Effect.succeed(p)
            : Effect.fail(
                new GcpError({
                  operation: "config:get-value:project",
                  message:
                    "no active gcloud project — run `gcloud config set project <id>`",
                }),
              ),
        ),
      )

    const accessToken = gcloud.text("auth:print-access-token", [
      "auth",
      "print-access-token",
    ])

    const osLoginUid = gcloud
      .json<{
        readonly posixAccounts?: ReadonlyArray<{ readonly uid?: string }>
      }>("compute:os-login:describe-profile", [
        "compute",
        "os-login",
        "describe-profile",
      ])
      .pipe(
        Effect.map((p) => Option.fromNullable(p.posixAccounts?.[0]?.uid)),
        Effect.catchAll(() => Effect.succeed(Option.none<string>())),
      )

    return Auth.of({
      callerAccount,
      activeProject,
      accessToken,
      osLoginUid,
    })
  }),
)
