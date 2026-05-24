import { Effect, Layer } from "effect"
import { writeFileSync, mkdirSync } from "node:fs"
import { SecretStore } from "../../services/backend/SecretStore.ts"
import { ConfigService } from "../../services/ConfigService.ts"
import { UserError } from "../../infra/Errors.ts"
import type { Secret } from "../../schema/Secret.ts"
import { secretsDir, secretsFile } from "./localPaths.ts"
import { readSecretFile, type SecretFile } from "./localSecrets.ts"

/**
 * Local implementation of SecretStore. Values live in a per-project JSON file
 * under `~/.afk/secrets/` (keyed by gitUrl), plaintext at mode 0600 — the same
 * posture as `~/.aws/credentials`. The `secret:<name>` reference syntax in
 * `.afk.env` is identical to every other Backend; only the backing store moves
 * to the developer's machine. `LocalCompute` reads the same file to inject
 * values into a Run's env at launch (no in-container fetch).
 */
export const LocalSecretStoreLive = Layer.effect(
  SecretStore,
  Effect.gen(function* () {
    const cfg = yield* ConfigService

    const gitUrl = cfg.load.pipe(Effect.map((r) => r.config.gitUrl))

    const writeFile = (url: string, data: SecretFile): Effect.Effect<void, UserError> =>
      Effect.try({
        try: () => {
          mkdirSync(secretsDir(), { recursive: true })
          writeFileSync(secretsFile(url), JSON.stringify(data, null, 2) + "\n", {
            mode: 0o600,
          })
        },
        catch: (cause) =>
          new UserError({ message: `could not write local secret store: ${String(cause)}` }),
      })

    return SecretStore.of({
      put: (name, value) =>
        Effect.gen(function* () {
          const url = yield* gitUrl
          const data = readSecretFile(url)
          data[name] = { value, lastModified: new Date().toISOString() }
          yield* writeFile(url, data)
        }),

      delete: (name) =>
        Effect.gen(function* () {
          const url = yield* gitUrl
          const data = readSecretFile(url)
          if (!(name in data)) {
            return yield* Effect.fail(
              new UserError({
                message: `secret '${name}' not found`,
                hint: "Use `afk secrets ls` to see stored secrets.",
              }),
            )
          }
          delete data[name]
          yield* writeFile(url, data)
        }),

      list: Effect.gen(function* () {
        const url = yield* gitUrl
        const data = readSecretFile(url)
        return Object.entries(data).map<Secret>(([name, s]) => ({
          name,
          reference: `secret:${name}`,
          lastModified: s.lastModified,
        }))
      }),
    })
  }),
)
