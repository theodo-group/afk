import { Effect, Layer } from "effect"
import { SecretStore } from "../../services/backend/SecretStore.ts"
import { SecretManager } from "../../adapters/gcp/SecretManager.ts"
import { Auth } from "../../adapters/gcp/Auth.ts"
import { ConfigService } from "../../services/ConfigService.ts"
import { GCP_SECRET_PREFIX } from "../../constants.ts"
import { UserError } from "../../infra/Errors.ts"
import type { Secret } from "../../schema/Secret.ts"
import { isValidSecretName } from "../../schema/Secret.ts"
import {
  parsePersonalSecrets,
  personalSecretId,
  renderPersonalSecrets,
  withSecret,
  withoutSecret,
  type PersonalSecrets,
} from "./GcpPersonalSecrets.ts"

const fullName = (name: string) => `${GCP_SECRET_PREFIX}-${name}`
const shortName = (full: string) =>
  full.startsWith(`${GCP_SECRET_PREFIX}-`)
    ? full.slice(GCP_SECRET_PREFIX.length + 1)
    : full

/**
 * GCP implementation of SecretStore. Team secrets are Secret Manager secrets
 * named `afk-secret-<name>`. Personal secrets are entries of the caller's one
 * `afk-personal-<owner key>` secret (see GcpPersonalSecrets), which only exists
 * once `afk team add` (or `afk provision`, for the founding member) created it.
 * The Run-time path dereferences both via the instance SA (see the
 * startup-script); this seam is only the developer-facing CRUD.
 */
export const GcpSecretStoreLive = Layer.effect(
  SecretStore,
  Effect.gen(function* () {
    const sm = yield* SecretManager
    const auth = yield* Auth
    const cfg = yield* ConfigService

    const project = Effect.gen(function* () {
      const { config } = yield* cfg.load
      return config.gcp?.projectId ?? (yield* auth.activeProject)
    })

    const personal = Effect.gen(function* () {
      const p = yield* project
      const account = yield* auth.callerAccount
      return { project: p, id: personalSecretId(account), account }
    })

    const readPersonal = personal.pipe(
      Effect.flatMap((c) =>
        sm.accessLatest(c.project, c.id).pipe(
          Effect.map(parsePersonalSecrets),
          Effect.mapError(
            (e) =>
              new UserError({
                message: `cannot read the personal secrets of ${c.account} (${c.id}): ${e.message.trim()}`,
                hint: `An admin creates them with \`afk team add <name> user:${c.account}\`.`,
              }),
          ),
        ),
      ),
    )

    const writePersonal = (secrets: PersonalSecrets) =>
      personal.pipe(
        Effect.flatMap((c) =>
          sm
            .addVersion(c.project, c.id, renderPersonalSecrets(secrets))
            .pipe(Effect.zipRight(sm.destroyOlderVersions(c.project, c.id))),
        ),
      )

    const checkName = (name: string) =>
      isValidSecretName(name)
        ? Effect.void
        : Effect.fail(
            new UserError({
              message: `invalid secret name '${name}'`,
              hint: "Use letters, digits, '.', '_' and '-' only.",
            }),
          )

    const notFound = (name: string) =>
      new UserError({
        message: `personal secret '${name}' not found`,
        hint: "Use `afk secrets ls --personal` to see yours.",
      })

    return SecretStore.of({
      put: (name, value, scope) =>
        scope === "personal"
          ? checkName(name).pipe(
              Effect.zipRight(readPersonal),
              Effect.flatMap((s) => writePersonal(withSecret(s, name, value))),
            )
          : project.pipe(
              Effect.flatMap((p) => sm.putSecret(p, fullName(name), value)),
            ),

      delete: (name, scope) =>
        scope === "personal"
          ? readPersonal.pipe(
              Effect.flatMap((s) =>
                s.has(name)
                  ? writePersonal(withoutSecret(s, name))
                  : Effect.fail(notFound(name)),
              ),
            )
          : project.pipe(
              Effect.flatMap((p) => sm.deleteSecret(p, fullName(name))),
            ),

      list: (scope) =>
        scope === "personal"
          ? Effect.all([readPersonal, personal]).pipe(
              Effect.map(([s, c]) =>
                [...s.keys()].map<Secret>((name) => ({
                  name,
                  scope,
                  reference: `${c.id}#${name}`,
                })),
              ),
            )
          : project.pipe(
              Effect.flatMap((p) => sm.listByPrefix(p, GCP_SECRET_PREFIX)),
              Effect.map((secrets) =>
                secrets.map<Secret>((s) => ({
                  name: shortName(s.name),
                  scope,
                  reference: s.name,
                  lastModified: s.createTime,
                })),
              ),
            ),
    })
  }),
)
