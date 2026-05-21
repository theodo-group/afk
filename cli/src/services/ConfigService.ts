import { Context, Effect, Layer, Schema } from "effect"
import { existsSync, readFileSync } from "node:fs"
import { resolve, basename } from "node:path"
import { AfkConfig, EnvEntry } from "../schema/Config.ts"
import { ConfigError, UserError } from "../infra/Errors.ts"
import { CONFIG_FILE, ENV_FILE, SSM_SECRET_PREFIX } from "../constants.ts"

export interface ResolvedConfig {
  readonly config: AfkConfig
  readonly envEntries: ReadonlyArray<EnvEntry>
  readonly projectRoot: string
  readonly sourceRepoName: string
}

export class ConfigService extends Context.Tag("ConfigService")<
  ConfigService,
  {
    /** Load + validate the project config and .afk.env. */
    readonly load: Effect.Effect<ResolvedConfig, ConfigError | UserError>
  }
>() {}

const findProjectRoot = (start: string): string | null => {
  let dir = start
  while (true) {
    if (existsSync(resolve(dir, CONFIG_FILE))) return dir
    const parent = resolve(dir, "..")
    if (parent === dir) return null
    dir = parent
  }
}

const parseEnvLine = (raw: string): EnvEntry | null => {
  const line = raw.trim()
  if (!line || line.startsWith("#")) return null
  const eq = line.indexOf("=")
  if (eq < 0) return null
  const name = line.slice(0, eq).trim()
  const value = line.slice(eq + 1).trim()
  if (!name) return null
  if (value.startsWith("ssm:")) {
    return { kind: "ssm", name, ssmName: value.slice(4) }
  }
  return { kind: "plain", name, value }
}

const deriveRepoName = (gitUrl: string): string => {
  const stripped = gitUrl.replace(/\.git$/, "")
  return basename(stripped) || "repo"
}

export const ConfigServiceLive = Layer.succeed(
  ConfigService,
  ConfigService.of({
    load: Effect.gen(function* () {
      const root = findProjectRoot(process.cwd())
      if (!root) {
        return yield* Effect.fail(
          new UserError({
            message: `No ${CONFIG_FILE} found in this directory or any parent.`,
            hint: "Run `afk init` to scaffold one.",
          }),
        )
      }
      const configPath = resolve(root, CONFIG_FILE)
      const raw = yield* Effect.try({
        try: () => readFileSync(configPath, "utf8"),
        catch: (cause) =>
          new ConfigError({
            path: configPath,
            message: `cannot read: ${String(cause)}`,
          }),
      })
      const parsed = yield* Effect.try({
        try: () => JSON.parse(raw) as unknown,
        catch: (cause) =>
          new ConfigError({
            path: configPath,
            message: `invalid JSON: ${String(cause)}`,
          }),
      })
      const config = yield* Schema.decodeUnknown(AfkConfig)(parsed).pipe(
        Effect.mapError(
          (e) =>
            new ConfigError({ path: configPath, message: String(e) }),
        ),
      )

      const envPath = resolve(root, ENV_FILE)
      const envEntries: EnvEntry[] = []
      if (existsSync(envPath)) {
        const envRaw = yield* Effect.try({
          try: () => readFileSync(envPath, "utf8"),
          catch: (cause) =>
            new ConfigError({
              path: envPath,
              message: `cannot read: ${String(cause)}`,
            }),
        })
        for (const line of envRaw.split("\n")) {
          const entry = parseEnvLine(line)
          if (entry) {
            if (
              entry.kind === "ssm" &&
              !entry.ssmName.startsWith(SSM_SECRET_PREFIX)
            ) {
              return yield* Effect.fail(
                new ConfigError({
                  path: envPath,
                  message: `SSM reference for '${entry.name}' must start with '${SSM_SECRET_PREFIX}/' (got '${entry.ssmName}')`,
                }),
              )
            }
            envEntries.push(entry)
          }
        }
      }

      return {
        config,
        envEntries,
        projectRoot: root,
        sourceRepoName: deriveRepoName(config.gitUrl),
      }
    }),
  }),
)
