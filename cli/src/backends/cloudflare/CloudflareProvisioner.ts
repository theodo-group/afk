import { Effect, Layer } from "effect"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { ConfigService } from "../../services/ConfigService.ts"
import { Subprocess } from "../../infra/Subprocess.ts"
import { Output } from "../../infra/Output.ts"
import { CloudflareError, UserError } from "../../infra/Errors.ts"
import { patchWranglerToml, patchConfigWorkerUrl } from "../../infra/CfToml.ts"
import { cloudflareInstanceTierLabel } from "../../schema/Config.ts"
import { Provisioner } from "../../services/backend/Provisioner.ts"
import { CONFIG_FILE } from "../../constants.ts"
import { parseWranglerJsonArray } from "./wranglerJson.ts"

const D1_NAME = "afk-launcher-history"
const KV_TITLE = "DEVELOPERS_KV"
const MIGRATION = "migrations/0001_runs.sql"

const firstMatch = (s: string, re: RegExp): string | null => {
  const m = s.match(re)
  return m ? m[1]! : null
}

/**
 * Cloudflare provisioning is the ~8 manual `wrangler` commands — installs Worker
 * deps, creates the D1 database + KV namespace (idempotent — reuses existing),
 * runs the migration, deploys the launcher Worker, and stores the CF_API_TOKEN
 * secret. Concrete ids are patched into wrangler.toml and the deployed URL into
 * afk.config.json automatically. Prereqs: `afk init --provider cloudflare` and
 * `afk golden build` (the Containers image must exist before deploy).
 */
export const CloudflareProvisionerLive = Layer.effect(
  Provisioner,
  Effect.gen(function* () {
    const cfg = yield* ConfigService
    const sub = yield* Subprocess
    const out = yield* Output

    const provision = Effect.gen(function* () {
      const { projectRoot, config } = yield* cfg.load

      const apiToken = process.env.CLOUDFLARE_API_TOKEN
      if (!apiToken) {
        return yield* Effect.fail(
          new CloudflareError({
            operation: "provision",
            message:
              "CLOUDFLARE_API_TOKEN is not set (add it to .env or export it).",
          }),
        )
      }

      const workerDir = resolve(projectRoot, "worker", "afk")
      const tomlPath = resolve(workerDir, "wrangler.toml")
      if (!existsSync(tomlPath)) {
        return yield* Effect.fail(
          new UserError({
            message: `no worker/afk/wrangler.toml at ${workerDir}.`,
            hint: "Run `afk init --provider cloudflare` first.",
          }),
        )
      }

      // wrangler reads CLOUDFLARE_API_TOKEN from the env (already loaded) and the
      // config from cwd; run everything from the worker dir.
      const wrangler = (args: ReadonlyArray<string>, stdin?: string) =>
        sub.run("wrangler", args, { cwd: workerDir, stdin }).pipe(
          Effect.mapError(
            (e) =>
              new CloudflareError({
                operation: `wrangler ${args[0]}`,
                message: e.stderr || e.stdout || String(e),
              }),
          ),
        )

      // Idempotently ensure one wrangler resource (D1 db / KV namespace):
      // list → reuse the existing match, else create it. Returns its id and
      // patches it into wrangler.toml.
      const ensureResource = <T>(input: {
        readonly listArgs: ReadonlyArray<string>
        readonly listOperation: string
        readonly findExisting: (resources: ReadonlyArray<T>) => T | undefined
        readonly idOf: (resource: T) => string
        readonly displayName: string
        readonly createArgs: ReadonlyArray<string>
        readonly idRegex: RegExp
        readonly parseOperation: string
        readonly parseMessage: (stdout: string) => string
        readonly tomlPatch: (
          id: string,
        ) => Parameters<typeof patchWranglerToml>[1]
      }) =>
        Effect.gen(function* () {
          const listed = yield* wrangler(input.listArgs)
          const resources = yield* parseWranglerJsonArray<T>(
            listed.stdout,
            input.listOperation,
          )
          const existing = input.findExisting(resources)
          let resourceId: string
          if (existing) {
            resourceId = input.idOf(existing)
            yield* out.print(`  reusing ${input.displayName} (${resourceId})`)
          } else {
            const created = yield* wrangler(input.createArgs)
            const id = firstMatch(created.stdout, input.idRegex)
            if (!id) {
              return yield* Effect.fail(
                new CloudflareError({
                  operation: input.parseOperation,
                  message: input.parseMessage(created.stdout),
                }),
              )
            }
            resourceId = id
            yield* out.print(`  created ${input.displayName} (${resourceId})`)
          }
          patchWranglerToml(tomlPath, input.tomlPatch(resourceId))
          return resourceId
        })

      yield* out.print("• installing Worker dependencies (npm install)…")
      yield* sub.run("npm", ["install"], { cwd: workerDir }).pipe(
        Effect.mapError(
          (e) =>
            new CloudflareError({
              operation: "npm install",
              message: e.stderr || String(e),
            }),
        ),
      )

      yield* out.print("• ensuring D1 database…")
      const databaseId = yield* ensureResource<{
        uuid: string
        name: string
      }>({
        listArgs: ["d1", "list", "--json"],
        listOperation: "d1 list",
        findExisting: (dbs) => dbs.find((d) => d.name === D1_NAME),
        idOf: (db) => db.uuid,
        displayName: D1_NAME,
        createArgs: ["d1", "create", D1_NAME],
        idRegex: /database_id = "([^"]+)"/,
        parseOperation: "d1 create",
        parseMessage: (stdout) =>
          `could not parse database_id from:\n${stdout}`,
        tomlPatch: (databaseId) => ({ databaseId }),
      })

      yield* out.print("• ensuring KV namespace…")
      const kvId = yield* ensureResource<{
        id: string
        title: string
      }>({
        listArgs: ["kv", "namespace", "list"],
        listOperation: "kv list",
        findExisting: (ns) =>
          ns.find(
            (n) => n.title === KV_TITLE || n.title.endsWith(`-${KV_TITLE}`),
          ),
        idOf: (n) => n.id,
        displayName: KV_TITLE,
        createArgs: ["kv", "namespace", "create", KV_TITLE],
        idRegex: /id = "([^"]+)"/,
        parseOperation: "kv create",
        parseMessage: (stdout) =>
          `could not parse namespace id from:\n${stdout}`,
        tomlPatch: (kvId) => ({ kvId }),
      })

      // R2 bucket for Session Artifacts — must exist before deploy (the
      // wrangler.toml r2_buckets binding resolves at deploy time). Idempotent:
      // a re-create on an existing bucket is treated as success.
      yield* out.print("• ensuring R2 bucket…")
      const artifactsBucket = `${config.cloudflare?.workerName ?? "afk-launcher"}-session-artifacts`
      yield* wrangler(["r2", "bucket", "create", artifactsBucket]).pipe(
        Effect.matchEffect({
          onSuccess: () =>
            out.print(`  created R2 bucket (${artifactsBucket})`),
          onFailure: (e) =>
            /already|exists|10004/i.test(e.message)
              ? out.print(`  reusing R2 bucket (${artifactsBucket})`)
              : Effect.fail(e),
        }),
      )

      // Instance sizing is deploy-time on CF: the [[containers]] block's
      // instance_type is fixed when the Worker deploys. Sync it from config so
      // `defaultInstanceTier` (named tier or custom {vcpu, memoryMib, diskMb})
      // is authoritative and a re-provision applies a size change.
      const tier = config.cloudflare?.defaultInstanceTier
      if (tier !== undefined) {
        patchWranglerToml(tomlPath, { instanceType: tier })
        yield* out.print(
          `• instance_type ${cloudflareInstanceTierLabel(tier)} (from ${CONFIG_FILE})`,
        )
      }

      // Migration is CREATE IF NOT EXISTS — safe to re-run.
      yield* out.print("• applying D1 migration…")
      yield* wrangler([
        "d1",
        "execute",
        D1_NAME,
        `--file=${MIGRATION}`,
        "--remote",
      ])

      yield* out.print("• deploying launcher Worker…")
      const deployed = yield* wrangler(["deploy"])
      const url = firstMatch(
        deployed.stdout,
        /(https:\/\/[^\s]+\.workers\.dev)/,
      )
      if (!url) {
        return yield* Effect.fail(
          new CloudflareError({
            operation: "deploy",
            message: `could not parse the deployed Worker URL from:\n${deployed.stdout}`,
          }),
        )
      }
      patchConfigWorkerUrl(resolve(projectRoot, CONFIG_FILE), url)
      yield* out.print(`  deployed ${url}`)

      // The Worker needs CF_API_TOKEN to serve /team and /secrets.
      yield* out.print("• setting CF_API_TOKEN Worker secret…")
      yield* wrangler(["secret", "put", "CF_API_TOKEN"], apiToken)

      return {
        summary: `✓ Cloudflare backend provisioned.\n  workerUrl ${url} (written to ${CONFIG_FILE})`,
        details: { backend: "cloudflare", workerUrl: url, databaseId, kvId },
        nextSteps: [
          "afk secrets put github-token <PAT>   # so Runs can clone source",
          "afk doctor                           # verify",
          'afk run "<command>"',
        ],
      }
    })

    return Provisioner.of({ provision })
  }),
)
