import { Effect, Layer } from "effect"
import { SecretStore } from "../../services/backend/SecretStore.ts"
import { KeyVault } from "../../adapters/azure/KeyVault.ts"
import { AzAuth } from "../../adapters/azure/AzAuth.ts"
import { ConfigService } from "../../services/ConfigService.ts"
import { UserError } from "../../infra/Errors.ts"
import { AZURE_SECRET_PREFIX } from "../../constants.ts"
import type { Secret } from "../../schema/Secret.ts"
import { makeResolveAzureCoords } from "./azureCoords.ts"
import { azureSecretNameProblem } from "./AzureRunPlan.ts"

const fullName = (name: string) => `${AZURE_SECRET_PREFIX}-${name}`
const shortName = (full: string) => full.slice(AZURE_SECRET_PREFIX.length + 1)

/**
 * Azure implementation of SecretStore: Key Vault secrets named
 * `afk-secret-<name>`. A Run's VM reads them at boot with its managed
 * identity's "Key Vault Secrets User" role; this seam is the developer CRUD.
 */
export const AzureSecretStoreLive = Layer.effect(
  SecretStore,
  Effect.gen(function* () {
    const kv = yield* KeyVault
    const auth = yield* AzAuth
    const cfg = yield* ConfigService
    const vault = makeResolveAzureCoords(cfg, auth).pipe(
      Effect.map((c) => c.names.keyVault),
    )

    const validName = (name: string) => {
      const problem = azureSecretNameProblem(name)
      return problem === undefined
        ? Effect.succeed(name)
        : Effect.fail(
            new UserError({
              message: problem,
              hint: "e.g. `github-token` rather than `github_token`.",
            }),
          )
    }

    return SecretStore.of({
      put: (name, value) =>
        Effect.all([validName(name), vault]).pipe(
          Effect.flatMap(([n, v]) => kv.putSecret(v, fullName(n), value)),
        ),
      delete: (name) =>
        vault.pipe(Effect.flatMap((v) => kv.deleteSecret(v, fullName(name)))),
      list: vault.pipe(
        Effect.flatMap((v) => kv.listByPrefix(v, AZURE_SECRET_PREFIX)),
        Effect.map((secrets) =>
          secrets.map<Secret>((s) => ({
            name: shortName(s.name),
            reference: s.name,
            lastModified: s.updated,
          })),
        ),
      ),
    })
  }),
)
