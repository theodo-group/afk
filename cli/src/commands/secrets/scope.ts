import { Options } from "@effect/cli"
import type { SecretScope } from "../../schema/Secret.ts"

export const personal = Options.boolean("personal").pipe(
  Options.withDescription(
    "Act on your own secrets: only Runs you launch can read them (e.g. your Claude token).",
  ),
)

export const scopeOf = (personal: boolean): SecretScope =>
  personal ? "personal" : "team"

export const label = (personal: boolean): string =>
  personal ? "personal secret" : "secret"
