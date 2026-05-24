import { Command } from "@effect/cli"
import { Effect } from "effect"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { ConfigService } from "../services/ConfigService.ts"
import { Subprocess } from "../infra/Subprocess.ts"
import { Terraform } from "../adapters/Terraform.ts"
import { Output } from "../infra/Output.ts"
import { CloudflareError, UserError } from "../infra/Errors.ts"
import { patchWranglerToml, patchConfigWorkerUrl } from "../infra/CfToml.ts"
import { CONFIG_FILE, DEFAULT_REGION } from "../constants.ts"

const D1_NAME = "afk-launcher-history"
const KV_TITLE = "DEVELOPERS_KV"
const MIGRATION = "migrations/0001_runs.sql"

/** Slice the first top-level JSON array out of wrangler stdout (which is
 * prefixed by human banners like the "agent skills" notice). */
const sliceJsonArray = (stdout: string): unknown => {
  const start = stdout.indexOf("[")
  const end = stdout.lastIndexOf("]")
  if (start === -1 || end === -1 || end < start) return []
  return JSON.parse(stdout.slice(start, end + 1))
}

const firstMatch = (s: string, re: RegExp): string | null => {
  const m = s.match(re)
  return m ? m[1]! : null
}

/**
 * `afk provision` — runs the one-time backing-infra setup for the active
 * backend, so the developer never leaves the `afk` CLI.
 *
 * On **AWS**: `terraform init && terraform apply` against the `terraform/afk`
 * module `afk init` dropped in (VPC, IAM, sweeper Lambda, DynamoDB).
 *
 * On **Cloudflare**: the ~8 manual `wrangler` commands — installs Worker deps,
 * creates the D1 database + KV namespace (idempotent — reuses existing), runs
 * the migration, deploys the launcher Worker, and stores the CF_API_TOKEN
 * secret. Concrete ids are patched into wrangler.toml and the deployed URL into
 * afk.config.json automatically. Prereqs: `afk init --provider cloudflare` and
 * `afk golden build` (the [[containers]] image must exist before deploy).
 */
export const provision = Command.make("provision", {}, () =>
  Effect.gen(function* () {
    const cfg = yield* ConfigService
    const sub = yield* Subprocess
    const out = yield* Output
    const { config, projectRoot } = yield* cfg.load
    const backend = config.backend ?? "aws"

    // Local: nothing to stand up — the Backend is self-contained. Keep the
    // command in the uniform init → provision → golden build arc by answering
    // cleanly rather than erroring or being absent.
    if (backend === "local") {
      yield* out.emit({
        data: { backend: "local", provisioned: false },
        human: () =>
          out.print(
            [
              `Nothing to provision on the Local Backend.`,
              ``,
              `Next:`,
              `  afk golden build                     # build the local Golden Image`,
              `  afk secrets put github-token <PAT>   # so Runs can clone source`,
              `  afk run "<command>"`,
            ].join("\n"),
          ),
      })
      return
    }

    // AWS: provisioning is the Terraform module `afk init` dropped in. Run it
    // for the developer (init + apply) instead of making them cd + terraform.
    if (backend === "aws") {
      const tf = yield* Terraform
      const dir = resolve(projectRoot, "terraform", "afk")
      if (!existsSync(dir)) {
        return yield* Effect.fail(
          new UserError({
            message: `no terraform/afk module at ${dir}.`,
            hint: "Run `afk init --provider aws` first.",
          }),
        )
      }
      const region = config.aws?.region ?? DEFAULT_REGION
      yield* out.print(`• terraform init + apply (region ${region})…`)
      yield* tf.apply({ dir, vars: { aws_region: region } })
      yield* out.emit({
        data: { backend: "aws", region, terraformDir: dir },
        human: () =>
          out.print(
            [
              ``,
              `✓ AWS backend provisioned (VPC, IAM, sweeper Lambda, DynamoDB).`,
              ``,
              `Next:`,
              `  afk golden build                     # build the Golden AMI`,
              `  afk secrets put github-token <PAT>   # so Runs can clone source`,
              `  afk run "<command>"`,
            ].join("\n"),
          ),
      })
      return
    }

    // ---- Cloudflare ----
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
      sub
        .run("wrangler", args, { cwd: workerDir, stdin })
        .pipe(
          Effect.mapError(
            (e) =>
              new CloudflareError({
                operation: `wrangler ${args[0]}`,
                message: e.stderr || e.stdout || String(e),
              }),
          ),
        )

    yield* out.print("• installing Worker dependencies (npm install)…")
    yield* sub
      .run("npm", ["install"], { cwd: workerDir })
      .pipe(
        Effect.mapError(
          (e) =>
            new CloudflareError({
              operation: "npm install",
              message: e.stderr || String(e),
            }),
        ),
      )

    yield* out.print("• ensuring D1 database…")
    const d1List = yield* wrangler(["d1", "list", "--json"])
    const existingD1 = (sliceJsonArray(d1List.stdout) as Array<{
      uuid: string
      name: string
    }>).find((d) => d.name === D1_NAME)
    let databaseId: string
    if (existingD1) {
      databaseId = existingD1.uuid
      yield* out.print(`  reusing ${D1_NAME} (${databaseId})`)
    } else {
      const created = yield* wrangler(["d1", "create", D1_NAME])
      const id = firstMatch(created.stdout, /database_id = "([^"]+)"/)
      if (!id) {
        return yield* Effect.fail(
          new CloudflareError({
            operation: "d1 create",
            message: `could not parse database_id from:\n${created.stdout}`,
          }),
        )
      }
      databaseId = id
      yield* out.print(`  created ${D1_NAME} (${databaseId})`)
    }
    patchWranglerToml(tomlPath, { databaseId })

    yield* out.print("• ensuring KV namespace…")
    const kvList = yield* wrangler(["kv", "namespace", "list"])
    const existingKv = (sliceJsonArray(kvList.stdout) as Array<{
      id: string
      title: string
    }>).find((n) => n.title === KV_TITLE || n.title.endsWith(`-${KV_TITLE}`))
    let kvId: string
    if (existingKv) {
      kvId = existingKv.id
      yield* out.print(`  reusing ${KV_TITLE} (${kvId})`)
    } else {
      const created = yield* wrangler(["kv", "namespace", "create", KV_TITLE])
      const id = firstMatch(created.stdout, /id = "([^"]+)"/)
      if (!id) {
        return yield* Effect.fail(
          new CloudflareError({
            operation: "kv create",
            message: `could not parse namespace id from:\n${created.stdout}`,
          }),
        )
      }
      kvId = id
      yield* out.print(`  created ${KV_TITLE} (${kvId})`)
    }
    patchWranglerToml(tomlPath, { kvId })

    // Migration is CREATE IF NOT EXISTS — safe to re-run.
    yield* out.print("• applying D1 migration…")
    yield* wrangler(["d1", "execute", D1_NAME, `--file=${MIGRATION}`, "--remote"])

    yield* out.print("• deploying launcher Worker…")
    const deployed = yield* wrangler(["deploy"])
    const url = firstMatch(deployed.stdout, /(https:\/\/[^\s]+\.workers\.dev)/)
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

    yield* out.emit({
      data: { workerUrl: url, databaseId, kvId },
      human: () =>
        out.print(
          [
            ``,
            `✓ Cloudflare backend provisioned.`,
            `  workerUrl ${url} (written to ${CONFIG_FILE})`,
            ``,
            `Next:`,
            `  afk secrets put github-token <PAT>   # so Runs can clone source`,
            `  afk doctor                           # verify`,
            `  afk run "<command>"`,
          ].join("\n"),
        ),
    })
  }),
)
