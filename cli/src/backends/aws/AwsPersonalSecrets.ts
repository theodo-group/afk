import { createHash } from "node:crypto"
import { Either } from "effect"
import { UserError } from "../../infra/Errors.ts"
import {
  TAG_INSTANCE,
  TAG_OWNER,
  ssmPersonalSecretPrefix,
  ssmRunSecretPrefix,
} from "../../constants.ts"
import { resolveOwner, sessionNameOf } from "./OwnerId.ts"

/**
 * Functional core of personal secrets on AWS.
 *
 * An AWS [[owner]] is a session of a role several developers share, so there
 * is no per-developer identity to give a Run VM ahead of time — every Run boots
 * with the one instance role. Isolation therefore rides on tags, both ways:
 *
 * - A personal secret is a SecureString under `/<prefix>/personal/` tagged
 *   `afk:owner = ${aws:userid}`. The developer policy lets a caller read and
 *   write only parameters carrying their own userid.
 * - At launch, the CLI copies each personal secret the Run references to
 *   `/<prefix>/runs/<runId>/<name>`, tagged with the instance's ARN. The
 *   instance role may read (then delete) only parameters tagged with its own
 *   ARN, `${ec2:SourceInstanceARN}` — so a Run reads its Owner's secrets and no
 *   one else's.
 */

/** Keys an Owner's path. Paths cannot hold the `:` of a userid; the tag decides. */
export const ownerKey = (userId: string): string =>
  createHash("sha256").update(userId).digest("hex").slice(0, 10)

export const personalSecretPath = (
  prefix: string | undefined,
  userId: string,
): string => `${ssmPersonalSecretPrefix(prefix)}/${ownerKey(userId)}`

export const personalSecretName = (
  prefix: string | undefined,
  userId: string,
  name: string,
): string => `${personalSecretPath(prefix, userId)}/${name}`

export const runSecretName = (
  prefix: string | undefined,
  runId: string,
  name: string,
): string => `${ssmRunSecretPrefix(prefix)}/${runId}/${name}`

export const instanceArn = (
  region: string,
  accountId: string,
  instanceId: string,
): string => `arn:aws:ec2:${region}:${accountId}:instance/${instanceId}`

export const ownerTags = (userId: string) => [{ key: TAG_OWNER, value: userId }]

export const runSecretTags = (userId: string, arn: string) => [
  { key: TAG_OWNER, value: userId },
  { key: TAG_INSTANCE, value: arn },
]

/**
 * Personal secrets need an Owner that outlives a credential refresh: an
 * anonymous session's userid changes every hour, which would lock its holder
 * out of the secrets tagged with the previous one.
 */
export const requireNamedOwner = (
  userId: string,
): Either.Either<string, UserError> =>
  resolveOwner(userId).anonymous
    ? Either.left(
        new UserError({
          message: `personal secrets need a named AWS session; this one ('${sessionNameOf(userId) ?? userId}') is renamed on every credential refresh.`,
          hint: "Name your session: aws configure set role_session_name firstname.lastname --profile <profile>",
        }),
      )
    : Either.right(userId)
