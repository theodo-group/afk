import { Context, Effect, Layer } from "effect"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  cpSync,
} from "node:fs"
import { resolve } from "node:path"
import { S3 } from "../adapters/aws/S3.ts"
import { Sts } from "../adapters/aws/Sts.ts"
import { AwsError, CloudflareError, UserError } from "../infra/Errors.ts"
import {
  AFK_STATE_BUCKET_PREFIX,
  CONFIG_FILE,
  ENV_FILE,
} from "../constants.ts"

const TEMPLATE_TERRAFORM_DIR = resolve(
  import.meta.dir,
  "..",
  "..",
  "..",
  "terraform",
  "aws",
)
const TEMPLATE_CF_WORKER_DIR = resolve(
  import.meta.dir,
  "..",
  "..",
  "..",
  "worker",
  "cloudflare",
)

export interface InitInput {
  readonly provider: "aws" | "cloudflare"
  readonly region: string
  readonly projectDir: string
}

export interface InitResult {
  readonly provider: "aws" | "cloudflare"
  readonly configCreated: boolean
  readonly envCreated: boolean
  readonly gitignoreUpdated: boolean
  /** AWS-specific outputs (undefined for CF). */
  readonly stateBucket?: string
  readonly stateBucketCreated?: boolean
  readonly terraformDir?: string
  readonly terraformDirCreated?: boolean
  /** CF-specific outputs (undefined for AWS). */
  readonly workerDir?: string
  readonly workerDirCreated?: boolean
  /** Pre-formatted human report — printed verbatim by the CLI. */
  readonly humanReport: string
}

export class BootstrapService extends Context.Tag("BootstrapService")<
  BootstrapService,
  {
    readonly init: (
      input: InitInput,
    ) => Effect.Effect<InitResult, AwsError | CloudflareError | UserError>
  }
>() {}

const upsertGitignore = (projectDir: string): boolean => {
  const gitignorePath = resolve(projectDir, ".gitignore")
  const gitignoreContents = existsSync(gitignorePath)
    ? readFileSync(gitignorePath, "utf8")
    : ""
  if (gitignoreContents.split("\n").includes(ENV_FILE)) return false
  appendFileSync(
    gitignorePath,
    (gitignoreContents.endsWith("\n") || gitignoreContents === ""
      ? ""
      : "\n") + `${ENV_FILE}\n.afk/\n`,
  )
  return true
}

const upsertEnvFile = (projectDir: string): boolean => {
  const envPath = resolve(projectDir, ENV_FILE)
  if (existsSync(envPath)) return false
  writeFileSync(
    envPath,
    [
      `# Plain values for non-secrets:`,
      `# LOG_LEVEL=debug`,
      `#`,
      `# Secret references (canonical form, all backends):`,
      `# ANTHROPIC_API_KEY=secret:anthropic-key`,
      `# Use \`afk secrets put <name> <value>\` to store values.`,
      ``,
    ].join("\n"),
  )
  return true
}

export const BootstrapServiceLive = Layer.effect(
  BootstrapService,
  Effect.gen(function* () {
    const s3 = yield* S3
    const sts = yield* Sts

    const initAws = (input: InitInput): Effect.Effect<InitResult, AwsError | UserError> =>
      Effect.gen(function* () {
        const { region, projectDir } = input
        const identity = yield* sts.callerIdentity
        const stateBucket = `${AFK_STATE_BUCKET_PREFIX}-${identity.Account}-${region}`

        const exists = yield* s3.bucketExists(stateBucket)
        let stateBucketCreated = false
        if (!exists) {
          yield* s3.createStateBucket({ bucket: stateBucket, region })
          stateBucketCreated = true
        }

        const terraformDir = resolve(projectDir, "terraform", "afk")
        const terraformDirCreated = !existsSync(terraformDir)
        if (existsSync(TEMPLATE_TERRAFORM_DIR)) {
          mkdirSync(terraformDir, { recursive: true })
          yield* Effect.try({
            try: () => {
              cpSync(TEMPLATE_TERRAFORM_DIR, terraformDir, {
                recursive: true,
                errorOnExist: false,
                force: false,
              })
            },
            catch: (cause) =>
              new UserError({
                message: `failed to copy terraform module: ${String(cause)}`,
              }),
          })
          const backendTf = [
            `terraform {`,
            `  backend "s3" {`,
            `    bucket       = "${stateBucket}"`,
            `    key          = "afk/terraform.tfstate"`,
            `    region       = "${region}"`,
            `    encrypt      = true`,
            `    use_lockfile = true`,
            `  }`,
            `}`,
            ``,
          ].join("\n")
          writeFileSync(resolve(terraformDir, "backend.tf"), backendTf)
        }

        const configPath = resolve(projectDir, CONFIG_FILE)
        let configCreated = false
        if (!existsSync(configPath)) {
          writeFileSync(
            configPath,
            JSON.stringify(
              {
                backend: "aws",
                gitUrl: "",
                mainService: "agent",
                defaultInstanceType: "t3.medium",
                allowedInstanceTypes: [
                  "t3.medium",
                  "t3.large",
                  "t3.xlarge",
                  "m6a.large",
                  "m6a.xlarge",
                  "m6a.2xlarge",
                  "m6a.4xlarge",
                ],
                defaultTimeoutHours: 4,
                golden: { cachedImages: [] },
                aws: { region },
              },
              null,
              2,
            ) + "\n",
          )
          configCreated = true
        }

        const envCreated = upsertEnvFile(projectDir)
        const gitignoreUpdated = upsertGitignore(projectDir)

        const status = (b: boolean) => (b ? "created" : "already present")
        const humanReport = [
          `state bucket       ${stateBucket} (${status(stateBucketCreated)})`,
          `terraform dir      ${terraformDir} (${status(terraformDirCreated)})`,
          `afk.config.json    ${status(configCreated)}`,
          `.afk.env           ${status(envCreated)}`,
          `.gitignore         ${gitignoreUpdated ? "updated" : "already had .afk.env / .afk/"}`,
          ``,
          `Next:`,
          `  1. cd ${terraformDir} && terraform init && terraform apply`,
          `  2. afk golden build           # one-time golden AMI build (5-10 min)`,
          `  3. afk secrets put github-token <PAT>`,
          `  4. afk run "<your command>"`,
        ].join("\n")

        return {
          provider: "aws" as const,
          stateBucket,
          stateBucketCreated,
          terraformDir,
          terraformDirCreated,
          configCreated,
          envCreated,
          gitignoreUpdated,
          humanReport,
        }
      })

    const initCloudflare = (
      input: InitInput,
    ): Effect.Effect<InitResult, CloudflareError | UserError> =>
      Effect.gen(function* () {
        const { projectDir } = input

        if (!process.env.CLOUDFLARE_API_TOKEN) {
          return yield* Effect.fail(
            new CloudflareError({
              operation: "init",
              message:
                "CLOUDFLARE_API_TOKEN env var is not set. Create a token with `Workers Scripts:Edit`, `Containers:Edit`, `Access:Edit`, `D1:Edit`, `Workers KV:Edit` and export it before running `afk init --provider cloudflare`.",
            }),
          )
        }

        const workerDir = resolve(projectDir, "worker", "afk")
        const workerDirCreated = !existsSync(workerDir)
        if (existsSync(TEMPLATE_CF_WORKER_DIR)) {
          mkdirSync(workerDir, { recursive: true })
          yield* Effect.try({
            try: () => {
              cpSync(TEMPLATE_CF_WORKER_DIR, workerDir, {
                recursive: true,
                errorOnExist: false,
                force: false,
              })
            },
            catch: (cause) =>
              new UserError({
                message: `failed to copy CF Worker module: ${String(cause)}`,
              }),
          })

          // Render wrangler.toml from the .template, leaving real-resource
          // placeholders for the developer to fill in (the CLI can't create
          // D1/KV without an interactive wrangler login).
          const templatePath = resolve(workerDir, "wrangler.toml.template")
          if (existsSync(templatePath)) {
            const tpl = readFileSync(templatePath, "utf8")
            const rendered = tpl
              .replace(/\{\{worker_name\}\}/g, "afk-launcher")
              .replace(/\{\{account_id\}\}/g, "REPLACE_ME")
              .replace(/\{\{placement\}\}/g, "smart")
              .replace(
                /\{\{golden_image_uri\}\}/g,
                "registry.cloudflare.com/REPLACE_ME/afk-golden:latest",
              )
              .replace(/\{\{default_instance_tier\}\}/g, "standard-1")
              .replace(/\{\{d1_database_id\}\}/g, "REPLACE_ME")
              .replace(/\{\{developers_kv_id\}\}/g, "REPLACE_ME")
            writeFileSync(resolve(workerDir, "wrangler.toml"), rendered)
          }
        }

        const configPath = resolve(projectDir, CONFIG_FILE)
        let configCreated = false
        if (!existsSync(configPath)) {
          writeFileSync(
            configPath,
            JSON.stringify(
              {
                backend: "cloudflare",
                gitUrl: "",
                mainService: "agent",
                defaultTimeoutHours: 4,
                cloudflare: {
                  accountId: "REPLACE_ME",
                  workerName: "afk-launcher",
                  workerUrl: "REPLACE_ME (e.g. https://afk-launcher.<acct>.workers.dev)",
                  placement: "smart",
                  defaultInstanceTier: "standard-1",
                  cachedImages: [],
                },
              },
              null,
              2,
            ) + "\n",
          )
          configCreated = true
        }

        const envCreated = upsertEnvFile(projectDir)
        const gitignoreUpdated = upsertGitignore(projectDir)

        const status = (b: boolean) => (b ? "created" : "already present")
        const humanReport = [
          `worker dir         ${workerDir} (${status(workerDirCreated)})`,
          `afk.config.json    ${status(configCreated)}`,
          `.afk.env           ${status(envCreated)}`,
          `.gitignore         ${gitignoreUpdated ? "updated" : "already had .afk.env / .afk/"}`,
          ``,
          `Next (run these manually — afk does not invoke wrangler for you):`,
          `  1. cd ${workerDir}`,
          `  2. npm install`,
          `  3. wrangler d1 create afk-launcher-history`,
          `     → copy the database_id into wrangler.toml`,
          `  4. wrangler kv:namespace create DEVELOPERS_KV`,
          `     → copy the namespace id into wrangler.toml`,
          `  5. wrangler d1 execute afk-launcher-history --file=migrations/0001_runs.sql --remote`,
          `  6. fill in your account_id in wrangler.toml + afk.config.json (cloudflare.accountId)`,
          `  7. afk golden build      # PR 4 — build + push the Golden Container image`,
          `  8. wrangler deploy`,
          `  9. wrangler secret put CF_API_TOKEN`,
          ` 10. set cloudflare.workerUrl in afk.config.json to the deployed Worker URL`,
          ` 11. afk run "<your command>"`,
        ].join("\n")

        return {
          provider: "cloudflare" as const,
          workerDir,
          workerDirCreated,
          configCreated,
          envCreated,
          gitignoreUpdated,
          humanReport,
        }
      })

    return BootstrapService.of({
      init: (input) =>
        input.provider === "cloudflare" ? initCloudflare(input) : initAws(input),
    })
  }),
)
