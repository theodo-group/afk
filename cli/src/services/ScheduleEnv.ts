import type { EnvEntry } from "../schema/Config.ts"

/**
 * The plain names a [[schedule|Schedule]] may carry as a literal value.
 *
 * Exactly one, and it is not a credential: `AFK_SKIP_SETUP` is afk's own
 * fast-path switch, and a smoke [[entry|Entry]] is unusable without it.
 *
 * A rule shaped like `AFK_*` was considered and refused. `AFK_GITLAB_TOKEN`
 * matches it, and that is precisely the name a developer pastes a token into —
 * a shape-based exemption waves through the one name that matters most. A list
 * of names has no such edge: anything new has to be argued for by name.
 */
export const PLAIN_ALLOWED: ReadonlySet<string> = new Set(["AFK_SKIP_SETUP"])

export const plainEntryAllowed = (name: string): boolean =>
  PLAIN_ALLOWED.has(name)

/**
 * The references in `refs` that no stored secret answers.
 *
 * Takes the whole stored list rather than probing per reference, so a caller
 * spends one `SecretStore.list` round trip whatever the reference count.
 */
export const missingRefs = (
  refs: ReadonlyArray<string>,
  storedNames: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const have = new Set(storedNames)
  return [...new Set(refs)].filter((r) => !have.has(r))
}

export interface ScheduleEnvResolution {
  /** What every Entry row carries, in `.afk.env` order. */
  readonly env: ReadonlyArray<EnvEntry>
  /** Every reason this environment cannot be scheduled, aggregated. */
  readonly problems: ReadonlyArray<string>
}

/**
 * Whether a submitter's environment can be pinned on a Schedule, and what the
 * rows would then hold.
 *
 * Pure, and shaped like `Triggers.validateEntries`: problems come back as data
 * so submit reports all of them at once. A developer fixing their `.afk.env`
 * should not discover it one round trip at a time.
 *
 * A plain value is **refused**, never dropped. Dropping would hand the Run a
 * silently incomplete environment, and leave the literal sitting unnoticed in
 * the file — which is how a live API token came to be in one.
 */
export const resolveScheduleEnv = (input: {
  readonly envEntries: ReadonlyArray<EnvEntry>
  readonly storedSecretNames: ReadonlyArray<string>
}): ScheduleEnvResolution => {
  const refused = input.envEntries.filter(
    (e) => e.kind === "plain" && !plainEntryAllowed(e.name),
  )
  const refs = input.envEntries.flatMap((e) =>
    e.kind === "secret" ? [e.secretName] : [],
  )
  return {
    env: input.envEntries,
    problems: [
      ...refused.map(
        (e) =>
          `'${e.name}' is a plain value — store it with \`afk secrets put <name>\` and reference it as \`${e.name}=secret:<name>\``,
      ),
      ...missingRefs(refs, input.storedSecretNames).map(
        (name) =>
          `secret '${name}' is referenced but not in the store — \`afk secrets put ${name}\``,
      ),
    ],
  }
}
