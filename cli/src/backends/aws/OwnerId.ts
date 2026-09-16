/**
 * Session names AWS's own tooling mints when nobody named the session. Each is
 * a fresh value per credential refresh, so it identifies a clock, not a person.
 *
 * Narrow on purpose. The costs are asymmetric: a false positive degrades a
 * working CI role to an unattributable Owner, while a false negative only
 * leaves an Owner as vague as it already was. So enumerate what AWS actually
 * mints, and accept anything a human or an operator could have chosen —
 * including an instance id or a task id, which name a machine but at least name
 * it for longer than an hour.
 */
const ANONYMOUS_SESSION: ReadonlyArray<RegExp> = [
  /^\d+$/,
  /^botocore-session-\d+$/,
  /^aws-sdk-(?:js|nodejs|java|cpp|php|ruby|dotnet|go)-\d+$/,
  /^aws-go-sdk-\d+$/,
  /^AWSCLI-Session-?\d*$/i,
]

export const isAnonymousSessionName = (sessionName: string): boolean =>
  sessionName.length === 0 ||
  ANONYMOUS_SESSION.some((pattern) => pattern.test(sessionName))

/**
 * The session half of an STS `UserId` — `<principal-id>:<session-name>` for an
 * assumed role, and nothing at all for an IAM user.
 */
export const sessionNameOf = (userId: string): string | undefined => {
  const colon = userId.indexOf(":")
  return colon === -1 ? undefined : userId.slice(colon + 1)
}

/**
 * The principal half of an STS `UserId`. Stable for the life of the role, and
 * therefore the Owner of last resort: it survives a credential refresh, which
 * an auto-generated session name does not.
 */
export const stableOwnerId = (userId: string): string => {
  const colon = userId.indexOf(":")
  return colon === -1 ? userId : userId.slice(0, colon)
}

/**
 * The [[owner]] to tag a Run with, and whether it names anybody.
 *
 * Prefer the `UserId` verbatim: it is what `${aws:userid}` expands to, and the
 * developer policy compares `afk:owner` against that with StringEquals, so any
 * transformation of the string denies the launch. Keeping it whole is also what
 * tells two developers on one shared role apart — the session name is the only
 * half that differs between them.
 *
 * Fall back to the principal id when the session name is machine-minted. Such a
 * name changes on every credential refresh, so tagging with it would lose the
 * Run from `afk ls` within the hour — the failure that made this function strip
 * the session name in the first place. The fallback is the pre-existing
 * behaviour, degraded knowingly: `anonymous` says so, and the caller warns.
 */
export const resolveOwner = (
  userId: string,
): { readonly id: string; readonly anonymous: boolean } => {
  const sessionName = sessionNameOf(userId)
  const anonymous =
    sessionName !== undefined && isAnonymousSessionName(sessionName)
  return { id: anonymous ? stableOwnerId(userId) : userId, anonymous }
}

/**
 * What to tell a developer whose session names nobody. Ready to print — the
 * Backend owns the wording because the remedy is AWS-specific, the commands
 * only log it.
 */
export const anonymousOwnerWarning = (userId: string): string =>
  `this AWS session is anonymous ('${sessionNameOf(userId) ?? userId}'), so afk cannot tell your Runs from your colleagues' on a shared role — they are all tagged with the role itself. Name your session: aws configure set role_session_name firstname.lastname --profile <profile>. A future release will refuse to launch without it.`

/**
 * Tag-filter values that mean "mine": exactly what `afk run` writes, and
 * nothing else.
 *
 * A `<principal-id>:*` wildcard used to sit here so Runs tagged under an older
 * convention stayed visible. It cannot: it matches every Run the shared role
 * launched, whoever launched it, which is how one developer came to terminate
 * another's. Runs tagged before named sessions are reachable through
 * `afk ls --all` and `afk kill <run-id>` until they expire.
 */
export const ownerTagValues = (owner: string): ReadonlyArray<string> => [owner]
