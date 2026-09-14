/**
 * The stable half of an STS caller identity.
 *
 * `sts:GetCallerIdentity` returns `UserId` as `<principal-id>:<session-name>`
 * for an assumed role. The session name is minted per credential refresh — the
 * aws CLI's default is `botocore-session-<epoch>` — so a Run tagged with the
 * whole string stops matching `afk ls` as soon as those credentials expire,
 * typically an hour later. The principal id is stable for the life of the role,
 * so that is what identifies an owner.
 *
 * Consequence: on a role several people assume, "mine" means "my role's". That
 * costs nothing when the session name is auto-generated, since it then carries
 * no identity to distinguish them by.
 */
export const stableOwnerId = (userId: string): string => {
  const colon = userId.indexOf(":")
  return colon === -1 ? userId : userId.slice(0, colon)
}

/**
 * Tag-filter values that match a Run whichever convention tagged it: the stable
 * id written now, and the `<principal-id>:<session-name>` written before. EC2
 * ORs a filter's values and honours `*`, so both forms resolve in one call.
 */
export const ownerTagValues = (userId: string): ReadonlyArray<string> => {
  const stable = stableOwnerId(userId)
  return [stable, `${stable}:*`]
}
