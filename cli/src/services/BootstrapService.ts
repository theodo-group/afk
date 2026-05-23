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
import { Ec2 } from "../adapters/aws/Ec2.ts"
import { Ssm } from "../adapters/aws/Ssm.ts"
import { Ecr } from "../adapters/aws/Ecr.ts"
import { Terraform } from "../adapters/Terraform.ts"
import { AwsError, CloudflareError, SubprocessError, UserError } from "../infra/Errors.ts"
import { deriveAccountId } from "../infra/CfToml.ts"
import {
  AFK_STATE_BUCKET_PREFIX,
  CONFIG_FILE,
  ECR_REPO_PREFIX,
  ENV_FILE,
  SSM_SECRET_PREFIX,
  TAG_GOLDEN,
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

export interface DestroyInput {
  readonly provider: "aws" | "cloudflare"
  readonly region: string
  readonly projectDir: string
  /** ECR repo suffix — the consumer's source-repo name (`afk/<name>`). */
  readonly sourceRepoName: string
  /** When false (default), report what would be deleted without touching anything. */
  readonly execute: boolean
}

export interface DestroyResult {
  readonly provider: "aws" | "cloudflare"
  readonly executed: boolean
  /** Human-readable lines describing each planned/performed action. */
  readonly actions: ReadonlyArray<string>
  /** Pre-formatted human report — printed verbatim by the CLI. */
  readonly humanReport: string
}

export class BootstrapService extends Context.Tag("BootstrapService")<
  BootstrapService,
  {
    readonly init: (
      input: InitInput,
    ) => Effect.Effect<InitResult, AwsError | CloudflareError | UserError>
    readonly destroy: (
      input: DestroyInput,
    ) => Effect.Effect<
      DestroyResult,
      AwsError | CloudflareError | UserError | SubprocessError
    >
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
    const ec2 = yield* Ec2
    const ssm = yield* Ssm
    const ecr = yield* Ecr
    const terraform = yield* Terraform

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
          `  1. afk provision              # terraform init + apply (VPC, IAM, sweeper, DynamoDB)`,
          `                                #   or run terraform yourself in ${terraformDir}`,
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

        const apiToken = process.env.CLOUDFLARE_API_TOKEN
        if (!apiToken) {
          return yield* Effect.fail(
            new CloudflareError({
              operation: "init",
              message:
                "CLOUDFLARE_API_TOKEN env var is not set. Create a token with `Workers Scripts:Edit`, `Containers:Edit`, `Cloudflare Images:Edit`, `Access:Edit`, `D1:Edit`, `Workers KV:Edit` and export it before running `afk init --provider cloudflare`.",
            }),
          )
        }

        // Derive the account id from the token so the developer never hand-fills
        // it (used for wrangler.toml's account_id + CF_ACCOUNT_ID and the
        // golden-image registry path).
        const accountId = yield* Effect.tryPromise({
          try: () => deriveAccountId(apiToken),
          catch: (cause) =>
            new CloudflareError({
              operation: "init:accountId",
              message: `could not derive Cloudflare account id: ${String(cause)}`,
            }),
        })

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
              .replace(/\{\{account_id\}\}/g, accountId)
              .replace(/\{\{placement\}\}/g, "smart")
              .replace(
                /\{\{golden_image_uri\}\}/g,
                `registry.cloudflare.com/${accountId}/afk-golden:latest`,
              )
              .replace(/\{\{default_instance_tier\}\}/g, "standard-1")
              .replace(/\{\{d1_database_id\}\}/g, "REPLACE_ME")
              .replace(/\{\{developers_kv_id\}\}/g, "REPLACE_ME")
            writeFileSync(resolve(workerDir, "wrangler.toml"), rendered)
          }
        }

        // Write or merge the `cloudflare:` block. If a config already exists
        // (e.g. an AWS one), we add/refresh the cloudflare block, flip the
        // active backend, and leave every other field — including an existing
        // `aws:` block — untouched.
        const configPath = resolve(projectDir, CONFIG_FILE)
        const cloudflareBlock = {
          accountId,
          workerName: "afk-launcher",
          workerUrl: "REPLACE_AFTER_PROVISION",
          placement: "smart",
          defaultInstanceTier: "standard-1",
          cachedImages: [] as string[],
        }
        let configCreated = false
        let configAction: string
        if (!existsSync(configPath)) {
          writeFileSync(
            configPath,
            JSON.stringify(
              {
                backend: "cloudflare",
                gitUrl: "",
                mainService: "agent",
                defaultTimeoutHours: 4,
                cloudflare: cloudflareBlock,
              },
              null,
              2,
            ) + "\n",
          )
          configCreated = true
          configAction = "created"
        } else {
          const existing = JSON.parse(readFileSync(configPath, "utf8")) as {
            backend?: string
            cloudflare?: Record<string, unknown>
            [k: string]: unknown
          }
          const hadCf = existing.cloudflare !== undefined
          const wasBackend = existing.backend
          existing.backend = "cloudflare"
          // Preserve any values the developer already set (e.g. cachedImages,
          // a custom workerUrl), only filling the accountId + defaults.
          existing.cloudflare = { ...cloudflareBlock, ...(existing.cloudflare ?? {}), accountId }
          writeFileSync(configPath, JSON.stringify(existing, null, 2) + "\n")
          configAction = hadCf
            ? "updated cloudflare block"
            : `added cloudflare block (backend ${wasBackend ?? "?"} → cloudflare)`
        }

        const envCreated = upsertEnvFile(projectDir)
        const gitignoreUpdated = upsertGitignore(projectDir)

        const status = (b: boolean) => (b ? "created" : "already present")
        const humanReport = [
          `worker dir         ${workerDir} (${status(workerDirCreated)})`,
          `afk.config.json    ${configAction} (accountId ${accountId})`,
          `.afk.env           ${status(envCreated)}`,
          `.gitignore         ${gitignoreUpdated ? "updated" : "already had .afk.env / .afk/"}`,
          ``,
          `Next:`,
          `  1. afk golden build     # build + push the Golden Container image`,
          `  2. afk provision        # create D1+KV, migrate, deploy Worker, set secret`,
          `  3. afk secrets put github-token <PAT>`,
          `  4. afk run "<your command>"`,
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

    const destroyAws = (
      input: DestroyInput,
    ): Effect.Effect<DestroyResult, AwsError | UserError | SubprocessError> =>
      Effect.gen(function* () {
        const { region, projectDir, sourceRepoName, execute } = input
        const identity = yield* sts.callerIdentity
        const stateBucket = `${AFK_STATE_BUCKET_PREFIX}-${identity.Account}-${region}`
        const terraformDir = resolve(projectDir, "terraform", "afk")
        const ecrRepo = `${ECR_REPO_PREFIX}/${sourceRepoName}`

        // ---- Discover what exists (best-effort; missing pieces are skipped) ----
        const goldenImages = yield* ec2
          .describeImages({
            region,
            owners: ["self"],
            tagFilters: [{ key: TAG_GOLDEN, values: ["true"] }],
          })
          .pipe(Effect.catchAll(() => Effect.succeed([])))
        const goldenIds = goldenImages.map((i) => i.imageId)
        const snapshotIds = goldenImages.flatMap((i) => i.snapshotIds)

        const secrets = yield* ssm
          .listByPrefix(region, SSM_SECRET_PREFIX)
          .pipe(Effect.catchAll(() => Effect.succeed([])))

        const bucketExists = yield* s3
          .bucketExists(stateBucket)
          .pipe(Effect.catchAll(() => Effect.succeed(false)))

        const hasTerraform = existsSync(terraformDir)

        const actions: string[] = []
        actions.push(
          goldenIds.length > 0
            ? `deregister ${goldenIds.length} golden AMI(s): ${goldenIds.join(", ")}` +
                (snapshotIds.length > 0
                  ? ` + delete ${snapshotIds.length} backing snapshot(s): ${snapshotIds.join(", ")}`
                  : "")
            : `no golden AMIs found in ${region}`,
        )
        actions.push(
          hasTerraform
            ? `terraform destroy in ${terraformDir} (VPC, IAM, sweeper Lambda, DynamoDB)`
            : `no terraform/afk dir — skipping terraform destroy`,
        )
        actions.push(
          secrets.length > 0
            ? `delete ${secrets.length} SSM secret(s) under ${SSM_SECRET_PREFIX}: ${secrets.map((s) => s.name).join(", ")}`
            : `no SSM secrets under ${SSM_SECRET_PREFIX}`,
        )
        actions.push(`delete ECR repository ${ecrRepo} (if present)`)
        actions.push(
          bucketExists
            ? `empty + delete Terraform state bucket ${stateBucket}`
            : `state bucket ${stateBucket} not found — skipping`,
        )

        if (!execute) {
          const humanReport = [
            `DRY RUN — nothing has been deleted.`,
            `Backend: aws   Region: ${region}   Account: ${identity.Account}`,
            ``,
            `Would perform:`,
            ...actions.map((a, i) => `  ${i + 1}. ${a}`),
            ``,
            `Re-run with --yes to execute. This is irreversible.`,
          ].join("\n")
          return {
            provider: "aws" as const,
            executed: false,
            actions,
            humanReport,
          }
        }

        // ---- Execute, ordered so the state bucket goes last ----
        const done: string[] = []

        for (const id of goldenIds) {
          yield* ec2.deregisterImage(region, id).pipe(
            Effect.catchAll((e) =>
              Effect.sync(() =>
                done.push(`! failed to deregister ${id}: ${e.message}`),
              ),
            ),
          )
        }
        if (goldenIds.length > 0) done.push(`deregistered ${goldenIds.length} golden AMI(s)`)

        // Snapshots only become deletable once the AMI referencing them is
        // deregistered, so this runs after the deregister loop above.
        for (const snap of snapshotIds) {
          yield* ec2.deleteSnapshot(region, snap).pipe(
            Effect.catchAll((e) =>
              Effect.sync(() =>
                done.push(`! failed to delete snapshot ${snap}: ${e.message}`),
              ),
            ),
          )
        }
        if (snapshotIds.length > 0) done.push(`deleted ${snapshotIds.length} backing snapshot(s)`)

        if (hasTerraform) {
          yield* terraform.destroy({
            dir: terraformDir,
            vars: { aws_region: region },
          })
          done.push(`terraform destroy completed`)
        }

        for (const s of secrets) {
          yield* ssm.deleteParameter(region, s.name).pipe(
            Effect.catchAll((e) =>
              Effect.sync(() =>
                done.push(`! failed to delete secret ${s.name}: ${e.message}`),
              ),
            ),
          )
        }
        if (secrets.length > 0) done.push(`deleted ${secrets.length} SSM secret(s)`)

        yield* ecr.deleteRepository(region, ecrRepo).pipe(
          Effect.catchAll((e) =>
            Effect.sync(() =>
              done.push(`! failed to delete ECR repo ${ecrRepo}: ${e.message}`),
            ),
          ),
        )
        done.push(`deleted ECR repository ${ecrRepo} (if it existed)`)

        if (bucketExists) {
          yield* s3.emptyAndDeleteBucket({ bucket: stateBucket, region })
          done.push(`emptied + deleted state bucket ${stateBucket}`)
        }

        const humanReport = [
          `Teardown complete (backend: aws, region: ${region}).`,
          ``,
          ...done.map((d) => `  - ${d}`),
          ``,
          `Note: local files (terraform/afk/, afk.config.json, .afk.env)`,
          `were left in place.`,
        ].join("\n")

        return {
          provider: "aws" as const,
          executed: true,
          actions: done,
          humanReport,
        }
      })

    const destroyCloudflare = (
      input: DestroyInput,
    ): Effect.Effect<DestroyResult, CloudflareError | UserError> =>
      Effect.gen(function* () {
        const workerDir = resolve(input.projectDir, "worker", "afk")
        // The CLI deliberately does not drive wrangler (see init). Teardown of
        // the CF backing resources is wrangler-owned, so we emit the exact
        // sequence rather than executing it.
        const actions = [
          `cd ${workerDir}`,
          `wrangler delete                    # remove launcher Worker + DOs`,
          `wrangler d1 delete afk-launcher-history`,
          `wrangler kv namespace delete --binding DEVELOPERS_KV`,
          `# delete the Golden Container image + any Access service tokens via the dashboard`,
        ]
        const humanReport = [
          `Cloudflare teardown is wrangler-driven; afk does not run wrangler for you.`,
          `Run these from the repo root (CLOUDFLARE_API_TOKEN must be exported):`,
          ``,
          ...actions.map((a) => `  ${a}`),
        ].join("\n")
        return {
          provider: "cloudflare" as const,
          executed: false,
          actions,
          humanReport,
        }
      })

    return BootstrapService.of({
      init: (input) =>
        input.provider === "cloudflare" ? initCloudflare(input) : initAws(input),
      destroy: (input) =>
        input.provider === "cloudflare"
          ? destroyCloudflare(input)
          : destroyAws(input),
    })
  }),
)
