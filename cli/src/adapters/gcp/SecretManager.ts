import { Context, Effect, Layer } from "effect"
import { Subprocess } from "../../infra/Subprocess.ts"
import { GcpError } from "../../infra/Errors.ts"
import { makeGcloudCli } from "./gcloudCli.ts"

export interface GcpSecret {
  readonly name: string
  readonly createTime?: string
}

/**
 * Secret Manager adapter — the GCP analogue of the secret bits of `Ssm`. Secret
 * names are flat (`afk-secret-<name>`); a put creates the secret if absent then
 * adds a new version, so the developer-facing `put` is upsert.
 */
export class SecretManager extends Context.Tag("SecretManager")<
  SecretManager,
  {
    readonly putSecret: (
      project: string,
      name: string,
      value: string,
    ) => Effect.Effect<void, GcpError>
    readonly deleteSecret: (
      project: string,
      name: string,
    ) => Effect.Effect<void, GcpError>
    readonly listByPrefix: (
      project: string,
      prefix: string,
    ) => Effect.Effect<ReadonlyArray<GcpSecret>, GcpError>
  }
>() {}

// The trailing segment of `projects/<n>/secrets/<id>` is the secret id.
const secretId = (resourceName: string): string =>
  resourceName.split("/").pop() ?? resourceName

export const SecretManagerLive = Layer.effect(
  SecretManager,
  Effect.gen(function* () {
    const sub = yield* Subprocess
    const gcloud = makeGcloudCli(sub)

    const putSecret = (project: string, name: string, value: string) =>
      Effect.gen(function* () {
        const exists = yield* gcloud.exists([
          "secrets",
          "describe",
          name,
          `--project=${project}`,
        ])
        if (!exists) {
          yield* gcloud.run("secrets:create", [
            "secrets",
            "create",
            name,
            `--project=${project}`,
            "--replication-policy=automatic",
          ])
        }
        // `--data-file=-` reads the value from stdin so it never lands in argv.
        yield* sub
          .run(
            "gcloud",
            [
              "secrets",
              "versions",
              "add",
              name,
              `--project=${project}`,
              "--data-file=-",
            ],
            { stdin: value },
          )
          .pipe(
            Effect.asVoid,
            Effect.mapError(
              (e) =>
                new GcpError({
                  operation: "secrets:versions:add",
                  message: e.stderr,
                }),
            ),
          )
      })

    const deleteSecret = (project: string, name: string) =>
      gcloud.run("secrets:delete", [
        "secrets",
        "delete",
        name,
        `--project=${project}`,
        "--quiet",
      ])

    const listByPrefix = (project: string, prefix: string) =>
      gcloud
        .json<ReadonlyArray<{ name: string; createTime?: string }>>(
          "secrets:list",
          [
            "secrets",
            "list",
            `--project=${project}`,
            `--filter=name~${prefix}`,
          ],
        )
        .pipe(
          Effect.map((rows) =>
            rows.map<GcpSecret>((r) => ({
              name: secretId(r.name),
              createTime: r.createTime,
            })),
          ),
        )

    return SecretManager.of({ putSecret, deleteSecret, listByPrefix })
  }),
)
