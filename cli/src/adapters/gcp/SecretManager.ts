import { Context, Effect, Layer } from "effect"
import { Subprocess } from "../../infra/Subprocess.ts"
import { GcpError } from "../../infra/Errors.ts"
import { gcpError, makeGcloudCli } from "./gcloudCli.ts"

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
    /** Create an empty secret; `false` when it already existed. */
    readonly ensureSecret: (
      project: string,
      name: string,
    ) => Effect.Effect<boolean, GcpError>
    /** Add a version to an existing secret (no create). */
    readonly addVersion: (
      project: string,
      name: string,
      value: string,
    ) => Effect.Effect<void, GcpError>
    /** The latest version's payload. */
    readonly accessLatest: (
      project: string,
      name: string,
    ) => Effect.Effect<string, GcpError>
    /**
     * Destroy every enabled version but the newest. A rewritten secret's old
     * versions still hold what was removed from it; this is what makes a
     * delete a delete.
     */
    readonly destroyOlderVersions: (
      project: string,
      name: string,
    ) => Effect.Effect<void, GcpError>
    /** Bind `member` to `role` on one secret (no project-wide grant). */
    readonly addSecretBinding: (
      project: string,
      name: string,
      member: string,
      role: string,
    ) => Effect.Effect<void, GcpError>
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

    const ensureSecret = (project: string, name: string) =>
      Effect.gen(function* () {
        const exists = yield* gcloud.exists([
          "secrets",
          "describe",
          name,
          `--project=${project}`,
        ])
        if (exists) return false
        yield* gcloud.run("secrets:create", [
          "secrets",
          "create",
          name,
          `--project=${project}`,
          "--replication-policy=automatic",
        ])
        return true
      })

    // `--data-file=-` reads the value from stdin so it never lands in argv.
    const addVersion = (project: string, name: string, value: string) =>
      sub
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

    const putSecret = (project: string, name: string, value: string) =>
      ensureSecret(project, name).pipe(
        Effect.zipRight(addVersion(project, name, value)),
      )

    // `versions access` prints the payload raw; `text` would trim a value that
    // ends in whitespace, so take stdout as is.
    const accessLatest = (project: string, name: string) =>
      sub
        .run("gcloud", [
          "secrets",
          "versions",
          "access",
          "latest",
          `--secret=${name}`,
          `--project=${project}`,
        ])
        .pipe(
          Effect.map((r) => r.stdout),
          Effect.mapError(gcpError("secrets:versions:access")),
        )

    const destroyOlderVersions = (project: string, name: string) =>
      gcloud
        .json<ReadonlyArray<{ name: string }>>("secrets:versions:list", [
          "secrets",
          "versions",
          "list",
          name,
          `--project=${project}`,
          "--filter=state=ENABLED",
          "--sort-by=~createTime",
        ])
        .pipe(
          Effect.flatMap((versions) =>
            Effect.forEach(versions.slice(1), (v) =>
              gcloud.run("secrets:versions:destroy", [
                "secrets",
                "versions",
                "destroy",
                secretId(v.name),
                `--secret=${name}`,
                `--project=${project}`,
                "--quiet",
              ]),
            ),
          ),
          Effect.asVoid,
        )

    const addSecretBinding = (
      project: string,
      name: string,
      member: string,
      role: string,
    ) =>
      gcloud.run("secrets:add-iam-policy-binding", [
        "secrets",
        "add-iam-policy-binding",
        name,
        `--project=${project}`,
        `--member=${member}`,
        `--role=${role}`,
      ])

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

    return SecretManager.of({
      putSecret,
      deleteSecret,
      listByPrefix,
      ensureSecret,
      addVersion,
      accessLatest,
      destroyOlderVersions,
      addSecretBinding,
    })
  }),
)
