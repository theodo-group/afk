import { Context, Effect, Layer } from "effect"
import { Subprocess } from "../../infra/Subprocess.ts"
import { AzureError } from "../../infra/Errors.ts"
import { makeAzCli } from "./azCli.ts"
import { withTempFile } from "./tempFile.ts"

export interface VaultSecret {
  readonly name: string
  readonly updated?: string
}

/**
 * Key Vault secrets adapter — the analogue of `SecretManager`. Developer-side
 * CRUD only: a Run's VM reads values with its own managed identity at boot.
 */
export class KeyVault extends Context.Tag("KeyVault")<
  KeyVault,
  {
    readonly putSecret: (
      vault: string,
      name: string,
      value: string,
    ) => Effect.Effect<void, AzureError>
    readonly deleteSecret: (
      vault: string,
      name: string,
    ) => Effect.Effect<void, AzureError>
    readonly listByPrefix: (
      vault: string,
      prefix: string,
    ) => Effect.Effect<ReadonlyArray<VaultSecret>, AzureError>
  }
>() {}

export const KeyVaultLive = Layer.effect(
  KeyVault,
  Effect.gen(function* () {
    const sub = yield* Subprocess
    const az = makeAzCli(sub)

    // The value travels in a private temp file, never in argv.
    const putSecret = (vault: string, name: string, value: string) =>
      withTempFile("secret", value, (path) =>
        az.run("keyvault:secret:set", [
          "keyvault",
          "secret",
          "set",
          "--vault-name",
          vault,
          "--name",
          name,
          "--file",
          path,
          "--encoding",
          "utf-8",
        ]),
      )

    // Key Vault soft-deletes; purge as well so the name can be put again at
    // once rather than colliding with its own tombstone for 90 days.
    const deleteSecret = (vault: string, name: string) =>
      az
        .run("keyvault:secret:delete", [
          "keyvault",
          "secret",
          "delete",
          "--vault-name",
          vault,
          "--name",
          name,
        ])
        .pipe(
          Effect.zipRight(
            az
              .run("keyvault:secret:purge", [
                "keyvault",
                "secret",
                "purge",
                "--vault-name",
                vault,
                "--name",
                name,
              ])
              .pipe(Effect.catchAll(() => Effect.void)),
          ),
        )

    const listByPrefix = (vault: string, prefix: string) =>
      az
        .json<
          ReadonlyArray<{
            readonly name?: string
            readonly attributes?: { readonly updated?: string }
          }>
        >("keyvault:secret:list", [
          "keyvault",
          "secret",
          "list",
          "--vault-name",
          vault,
        ])
        .pipe(
          Effect.map((secrets) =>
            secrets
              .filter((s) => s.name?.startsWith(`${prefix}-`) ?? false)
              .map<VaultSecret>((s) => ({
                name: s.name ?? "",
                updated: s.attributes?.updated,
              })),
          ),
        )

    return KeyVault.of({ putSecret, deleteSecret, listByPrefix })
  }),
)
