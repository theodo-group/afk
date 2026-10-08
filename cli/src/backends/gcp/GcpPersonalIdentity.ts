import { Effect } from "effect"
import type { Context } from "effect"
import type { GcpIam } from "../../adapters/gcp/Iam.ts"
import type { SecretManager } from "../../adapters/gcp/SecretManager.ts"
import type { GcpError } from "../../infra/Errors.ts"
import {
  GCP_ARTIFACTS_BUCKET_PREFIX,
  GCP_VM_SELF_DELETE_ROLE,
} from "../../constants.ts"
import {
  EMPTY_PERSONAL_PAYLOAD,
  accountOfMember,
  personalSecretId,
  personalServiceAccountEmail,
  personalServiceAccountId,
  teamSecretsCondition,
} from "./GcpPersonalSecrets.ts"

type Iam = Context.Tag.Service<typeof GcpIam>
type Sm = Context.Tag.Service<typeof SecretManager>

/**
 * The project roles the shared `afk-vm` service account holds in
 * terraform/gcp/iam.tf, which an Owner's own VM service account needs too: a
 * Run is the same Run whichever account it boots with. The team-secret grant
 * is conditioned separately (see `teamSecretsCondition`).
 */
const vmProjectRoles = (project: string): ReadonlyArray<string> => [
  "roles/artifactregistry.reader",
  "roles/logging.logWriter",
  `projects/${project}/roles/${GCP_VM_SELF_DELETE_ROLE}`,
]

const artifactsBucket = (project: string) =>
  `${GCP_ARTIFACTS_BUCKET_PREFIX}-${project}`

/**
 * Give an Owner what personal secrets need, idempotently: their own VM service
 * account (the shared account's grants + read on their personal secret), the
 * right to attach it to their Runs, and the personal-secret container they read
 * and write. Run by whoever may edit project IAM — `afk team add` for a new
 * member, `afk provision` for the founding one.
 */
export const ensurePersonalIdentity = (
  iam: Iam,
  sm: Sm,
  project: string,
  member: string,
): Effect.Effect<void, GcpError> =>
  Effect.gen(function* () {
    const account = accountOfMember(member)
    const vm = `serviceAccount:${personalServiceAccountEmail(project, account)}`
    const secret = personalSecretId(account)

    yield* iam.ensureServiceAccount(
      project,
      personalServiceAccountId(account),
      `AFK Runs of ${account}`,
    )
    yield* Effect.forEach(vmProjectRoles(project), (role) =>
      iam.addBinding(project, vm, role),
    )
    const number = yield* iam.projectNumber(project)
    yield* iam.addBinding(
      project,
      vm,
      "roles/secretmanager.secretAccessor",
      teamSecretsCondition(number),
    )
    yield* iam.addBucketBinding(
      artifactsBucket(project),
      vm,
      "roles/storage.objectCreator",
    )
    yield* iam.addServiceAccountBinding(
      project,
      personalServiceAccountEmail(project, account),
      member,
      "roles/iam.serviceAccountUser",
    )

    const created = yield* sm.ensureSecret(project, secret)
    if (created) {
      yield* sm.addVersion(project, secret, EMPTY_PERSONAL_PAYLOAD)
    }
    yield* sm.addSecretBinding(
      project,
      secret,
      vm,
      "roles/secretmanager.secretAccessor",
    )
    // Read to rewrite, add the rewrite, destroy the version it replaces.
    yield* Effect.forEach(
      [
        "roles/secretmanager.secretAccessor",
        "roles/secretmanager.secretVersionManager",
      ],
      (role) => sm.addSecretBinding(project, secret, member, role),
    )
  })

/**
 * Undo `ensurePersonalIdentity`: the personal secret goes with its Owner, and
 * so does their VM service account — project bindings first, so the policy is
 * not left naming a deleted account.
 */
export const removePersonalIdentity = (
  iam: Iam,
  sm: Sm,
  project: string,
  member: string,
): Effect.Effect<void, GcpError> =>
  Effect.gen(function* () {
    const account = accountOfMember(member)
    const email = personalServiceAccountEmail(project, account)
    const vm = `serviceAccount:${email}`
    const number = yield* iam.projectNumber(project)

    yield* Effect.forEach(vmProjectRoles(project), (role) =>
      iam.removeBinding(project, vm, role),
    )
    yield* iam.removeBinding(
      project,
      vm,
      "roles/secretmanager.secretAccessor",
      teamSecretsCondition(number),
    )
    yield* iam.removeBucketBinding(
      artifactsBucket(project),
      vm,
      "roles/storage.objectCreator",
    )
    yield* sm.deleteSecret(project, personalSecretId(account))
    yield* iam.deleteServiceAccount(project, email)
  })
