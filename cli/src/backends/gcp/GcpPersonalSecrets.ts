import { createHash } from "node:crypto"
import {
  GCP_PERSONAL_SECRET_PREFIX,
  GCP_SECRET_PREFIX,
  GCP_VM_SERVICE_ACCOUNT,
} from "../../constants.ts"

/**
 * Functional core of personal secrets on GCP.
 *
 * A Run reads secrets with the instance's service account, so keeping one
 * [[owner]]'s secrets from another Owner's Runs takes one service account per
 * Owner: `afk-vm-<owner key>`, granted what the shared `afk-vm` has plus read on
 * that Owner's personal secret. The Owner may attach (actAs) only their own, so
 * IAM — not the CLI — decides which Runs can read the value.
 *
 * The personal secrets themselves live in one Secret Manager secret per Owner,
 * `afk-personal-<owner key>`, rather than one per name: a developer cannot be
 * granted `secrets.create` on their own names only, so the admin creates the
 * container once (`afk team add`) and binds it on the resource itself, where no
 * IAM condition is needed. Its payload is one `name=<base64 value>` line per
 * secret.
 */

/** The account behind an IAM member (`user:dev@acme.com` → `dev@acme.com`). */
export const accountOfMember = (member: string): string =>
  (member.split(":").pop() ?? member).toLowerCase()

/**
 * A short, stable key naming an Owner in GCP resource ids, which cannot hold
 * an email (service-account ids are `[a-z][a-z0-9-]{5,29}`).
 */
export const ownerKey = (account: string): string =>
  createHash("sha256").update(account.toLowerCase()).digest("hex").slice(0, 10)

export const personalServiceAccountId = (account: string): string =>
  `${GCP_VM_SERVICE_ACCOUNT}-${ownerKey(account)}`

export const personalServiceAccountEmail = (
  project: string,
  account: string,
): string =>
  `${personalServiceAccountId(account)}@${project}.iam.gserviceaccount.com`

export const personalSecretId = (account: string): string =>
  `${GCP_PERSONAL_SECRET_PREFIX}-${ownerKey(account)}`

/**
 * The IAM condition keeping a VM service account to team secrets. Personal
 * secrets are bound per secret instead, so this must not match
 * `afk-personal-*` — hence the full `afk-secret-` prefix rather than `afk-`.
 * No commas: gcloud splits `--condition` on them.
 */
export const teamSecretsCondition = (projectNumber: string) => ({
  title: "afk-team-secrets-only",
  description: `Only team secrets (${GCP_SECRET_PREFIX}-*)`,
  expression: `resource.name.startsWith("projects/${projectNumber}/secrets/${GCP_SECRET_PREFIX}-")`,
})

/** An Owner's personal secrets, by name. */
export type PersonalSecrets = ReadonlyMap<string, string>

/** What an empty container holds: Secret Manager refuses an empty payload. */
export const EMPTY_PERSONAL_PAYLOAD = "# afk personal secrets\n"

export const parsePersonalSecrets = (payload: string): PersonalSecrets =>
  new Map(
    payload
      .split("\n")
      .filter((line) => line !== "" && !line.startsWith("#"))
      .flatMap((line) => {
        const eq = line.indexOf("=")
        return eq < 1
          ? []
          : [
              [
                line.slice(0, eq),
                Buffer.from(line.slice(eq + 1), "base64").toString("utf8"),
              ] as const,
            ]
      }),
  )

export const renderPersonalSecrets = (secrets: PersonalSecrets): string =>
  [
    EMPTY_PERSONAL_PAYLOAD.trimEnd(),
    ...[...secrets.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([name, value]) =>
          `${name}=${Buffer.from(value, "utf8").toString("base64")}`,
      ),
  ].join("\n") + "\n"

export const withSecret = (
  secrets: PersonalSecrets,
  name: string,
  value: string,
): PersonalSecrets => new Map([...secrets, [name, value]])

export const withoutSecret = (
  secrets: PersonalSecrets,
  name: string,
): PersonalSecrets =>
  new Map([...secrets].filter(([existing]) => existing !== name))
