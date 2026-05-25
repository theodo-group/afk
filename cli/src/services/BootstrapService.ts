import { HttpClient } from "@effect/platform"
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
import { ensureBackendRegionMatches } from "./TerraformBackend.ts"
import {
  AwsError,
  CloudflareError,
  SubprocessError,
  UserError,
} from "../infra/Errors.ts"
import { deriveAccountId } from "../infra/CfToml.ts"
import { Subprocess } from "../infra/Subprocess.ts"
import {
  AFK_STATE_BUCKET_PREFIX,
  CONFIG_FILE,
  ECR_REPO_PREFIX,
  ENV_FILE,
  GCP_DEFAULT_ALLOWED_MACHINE_TYPES,
  GCP_DEFAULT_MACHINE_TYPE,
  GCP_STATE_BUCKET_PREFIX,
  SESSION_ARTIFACT_DIR,
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
const TEMPLATE_GCP_TERRAFORM_DIR = resolve(
  import.meta.dir,
  "..",
  "..",
  "..",
  "terraform",
  "gcp",
)

export interface InitInput {
  readonly provider: "aws" | "cloudflare" | "local" | "gcp"
  readonly region: string
  readonly projectDir: string
}

export interface InitResult {
  readonly provider: "aws" | "cloudflare" | "local" | "gcp"
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
  readonly provider: "aws" | "cloudflare" | "local" | "gcp"
  readonly region: string
  readonly projectDir: string
  /** ECR repo suffix — the consumer's source-repo name (`afk/<name>`). */
  readonly sourceRepoName: string
  /** When false (default), report what would be deleted without touching anything. */
  readonly execute: boolean
}

export interface DestroyResult {
  readonly provider: "aws" | "cloudflare" | "local" | "gcp"
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
    ) => Effect.Effect<
      InitResult,
      AwsError | CloudflareError | UserError,
      HttpClient.HttpClient
    >
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
    (gitignoreContents.endsWith("\n") || gitignoreContents === "" ? "" : "\n") +
      `${ENV_FILE}\n.afk/\n${SESSION_ARTIFACT_DIR}/\n`,
  )
  return true
}

/**
 * Pick the example scm-token line for the .afk.env scaffold based on the
 * detected origin host. GitLab repos need `GITLAB_TOKEN` (consumed by the
 * entrypoint as `oauth2:<token>@…`); GitHub repos need `GITHUB_TOKEN`
 * (`x-access-token:<token>@…`). When the host is unknown we fall back to
 * the GitHub form as the documented default.
 */
const scmTokenExample = (gitUrl: string | null): string => {
  if (gitUrl === null) {
    return "# GITHUB_TOKEN=secret:github-token   # required so Runs can clone source"
  }
  try {
    const host = new URL(gitUrl).host
    if (/(^|\.)gitlab\b/i.test(host) || /gitlab/i.test(host)) {
      return "# GITLAB_TOKEN=secret:gitlab-token   # required so Runs can clone source"
    }
  } catch {
    // Non-URL (e.g. an ssh-style remote): fall through to the GitHub default.
  }
  return "# GITHUB_TOKEN=secret:github-token   # required so Runs can clone source"
}

const upsertEnvFile = (
  projectDir: string,
  gitUrl: string | null,
): boolean => {
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
      scmTokenExample(gitUrl),
      `# Use \`afk secrets put <name> <value>\` to store values.`,
      ``,
    ].join("\n"),
  )
  return true
}

/**
 * Read the `origin` remote URL of the working dir's git repo, or `null` when
 * there is no git repo / no origin remote. Used by `afk init` to pre-fill
 * `gitUrl` in `afk.config.json` so devs don't have to copy-paste it.
 */
const detectOriginUrl = (
  projectDir: string,
  run: (
    cmd: string,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<{ readonly stdout: string }, SubprocessError>,
): Effect.Effect<string | null> =>
  run("git", ["-C", projectDir, "remote", "get-url", "origin"]).pipe(
    Effect.map((r): string | null => r.stdout.trim() || null),
    Effect.catchAll(() => Effect.succeed(null as string | null)),
  )

export const BootstrapServiceLive = Layer.effect(
  BootstrapService,
  Effect.gen(function* () {
    const s3 = yield* S3
    const sts = yield* Sts
    const ec2 = yield* Ec2
    const ssm = yield* Ssm
    const ecr = yield* Ecr
    const terraform = yield* Terraform
    const sub = yield* Subprocess

    const initAws = (
      input: InitInput,
    ): Effect.Effect<InitResult, AwsError | UserError> =>
      Effect.gen(function* () {
        const { region, projectDir } = input
        const originUrl = yield* detectOriginUrl(projectDir, sub.run)
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
                gitUrl: originUrl ?? "",
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

        const envCreated = upsertEnvFile(projectDir, originUrl)
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
    ): Effect.Effect<
      InitResult,
      CloudflareError | UserError,
      HttpClient.HttpClient
    > =>
      Effect.gen(function* () {
        const { projectDir } = input
        const originUrl = yield* detectOriginUrl(projectDir, sub.run)

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
        const accountId = yield* deriveAccountId(apiToken)

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
                gitUrl: originUrl ?? "",
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
          if (
            (existing.gitUrl === undefined || existing.gitUrl === "") &&
            originUrl !== null
          ) {
            existing.gitUrl = originUrl
          }
          // Preserve any values the developer already set (e.g. cachedImages,
          // a custom workerUrl), only filling the accountId + defaults.
          existing.cloudflare = {
            ...cloudflareBlock,
            ...(existing.cloudflare ?? {}),
            accountId,
          }
          writeFileSync(configPath, JSON.stringify(existing, null, 2) + "\n")
          configAction = hadCf
            ? "updated cloudflare block"
            : `added cloudflare block (backend ${wasBackend ?? "?"} → cloudflare)`
        }

        const envCreated = upsertEnvFile(projectDir, originUrl)
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
        yield* ensureBackendRegionMatches({
          terraformDir,
          configRegion: region,
        })
        const ecrRepo = `${ECR_REPO_PREFIX}/${sourceRepoName}`

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
            ? `terraform destroy in ${terraformDir} (VPC, IAM, sweeper Lambda, DynamoDB, S3 artifacts bucket)`
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

        // Delete the state bucket last — it holds the tf state + lock, so it
        // must outlive the terraform destroy above.
        const done: string[] = []

        for (const id of goldenIds) {
          yield* ec2
            .deregisterImage(region, id)
            .pipe(
              Effect.catchAll((e) =>
                Effect.sync(() =>
                  done.push(`! failed to deregister ${id}: ${e.message}`),
                ),
              ),
            )
        }
        if (goldenIds.length > 0)
          done.push(`deregistered ${goldenIds.length} golden AMI(s)`)

        // Snapshots only become deletable once the AMI referencing them is
        // deregistered, so this runs after the deregister loop above.
        for (const snap of snapshotIds) {
          yield* ec2
            .deleteSnapshot(region, snap)
            .pipe(
              Effect.catchAll((e) =>
                Effect.sync(() =>
                  done.push(
                    `! failed to delete snapshot ${snap}: ${e.message}`,
                  ),
                ),
              ),
            )
        }
        if (snapshotIds.length > 0)
          done.push(`deleted ${snapshotIds.length} backing snapshot(s)`)

        if (hasTerraform) {
          yield* terraform.destroy({
            dir: terraformDir,
            vars: { aws_region: region },
          })
          done.push(`terraform destroy completed`)
        }

        for (const s of secrets) {
          yield* ssm
            .deleteParameter(region, s.name)
            .pipe(
              Effect.catchAll((e) =>
                Effect.sync(() =>
                  done.push(
                    `! failed to delete secret ${s.name}: ${e.message}`,
                  ),
                ),
              ),
            )
        }
        if (secrets.length > 0)
          done.push(`deleted ${secrets.length} SSM secret(s)`)

        yield* ecr
          .deleteRepository(region, ecrRepo)
          .pipe(
            Effect.catchAll((e) =>
              Effect.sync(() =>
                done.push(
                  `! failed to delete ECR repo ${ecrRepo}: ${e.message}`,
                ),
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
    ): Effect.Effect<
      DestroyResult,
      CloudflareError | UserError | SubprocessError
    > =>
      Effect.gen(function* () {
        const projectDir = input.projectDir
        const workerName = "afk-launcher"
        const d1Name = "afk-launcher-history"
        const kvTitle = "DEVELOPERS_KV"
        const containerName = "afk-launcher-runcontainer"
        const goldenRepo = "afk-golden"
        const artifactsBucket = `${workerName}-session-artifacts`

        // Run wrangler from the project root so it picks up CLOUDFLARE_API_TOKEN
        // from the inherited env (.env is auto-loaded by the CLI at startup).
        const wrangler = (args: ReadonlyArray<string>) =>
          sub.run("wrangler", args, { cwd: projectDir }).pipe(
            Effect.mapError(
              (e) =>
                new CloudflareError({
                  operation: `wrangler ${args[0]}`,
                  message: e.stderr || e.stdout || String(e),
                }),
            ),
          )
        const sliceArray = (s: string): Array<Record<string, string>> => {
          const a = s.indexOf("[")
          const b = s.lastIndexOf("]")
          if (a === -1 || b === -1 || b < a) return []
          try {
            return JSON.parse(s.slice(a, b + 1)) as Array<
              Record<string, string>
            >
          } catch {
            return []
          }
        }

        const actions = [
          `delete golden image tags (${goldenRepo}:*)`,
          `wrangler delete --name ${workerName}   # launcher Worker + DOs`,
          `wrangler containers delete ${containerName}   # outer Container app + live instances`,
          `wrangler d1 delete ${d1Name}`,
          `wrangler kv namespace delete <${kvTitle} id>`,
          `wrangler r2 bucket delete ${artifactsBucket}   # Session Artifacts (must be empty)`,
        ]

        if (!input.execute) {
          return {
            provider: "cloudflare" as const,
            executed: false,
            actions,
            humanReport: [
              `Would tear down the Cloudflare backend (re-run with --yes to execute):`,
              ``,
              ...actions.map((a) => `  ${a}`),
            ].join("\n"),
          }
        }

        const done: string[] = []

        const imgs = sliceArray(
          (yield* wrangler(["containers", "images", "list", "--json"])).stdout,
        ) as Array<{ name?: string; tags?: string[] }>
        const golden = imgs.find((i) => i.name === goldenRepo)
        for (const tag of golden?.tags ?? []) {
          yield* wrangler([
            "containers",
            "images",
            "delete",
            `${goldenRepo}:${tag}`,
          ])
          done.push(`deleted golden ${goldenRepo}:${tag}`)
        }

        // wrangler delete also tears down the Worker's Durable Objects.
        yield* wrangler(["delete", "--name", workerName])
        done.push(`deleted Worker ${workerName}`)

        // Outer Container application — NOT removed by the Worker delete; this
        // is what leaves live instances billing otherwise.
        const containers = sliceArray(
          (yield* wrangler(["containers", "list", "--json"])).stdout,
        ) as Array<{ id?: string; name?: string }>
        const app = containers.find((c) => c.name === containerName)
        if (app?.id) {
          yield* wrangler(["containers", "delete", app.id])
          done.push(`deleted container app ${containerName}`)
        }

        yield* wrangler(["d1", "delete", d1Name])
        done.push(`deleted D1 ${d1Name}`)

        // R2 bucket. `r2 bucket delete` refuses a non-empty bucket and wrangler
        // has no recursive flag, so this is best-effort: on failure we tell the
        // developer to empty it manually rather than abort the whole teardown.
        yield* wrangler(["r2", "bucket", "delete", artifactsBucket]).pipe(
          Effect.matchEffect({
            onSuccess: () =>
              Effect.sync(() =>
                done.push(`deleted R2 bucket ${artifactsBucket}`),
              ),
            onFailure: () =>
              Effect.sync(() =>
                done.push(
                  `R2 bucket ${artifactsBucket} not deleted (empty it, then \`wrangler r2 bucket delete ${artifactsBucket}\`)`,
                ),
              ),
          }),
        )

        const kvs = sliceArray(
          (yield* wrangler(["kv", "namespace", "list"])).stdout,
        ) as Array<{ id?: string; title?: string }>
        const kv = kvs.find(
          (n) => n.title === kvTitle || (n.title ?? "").endsWith(`-${kvTitle}`),
        )
        if (kv?.id) {
          yield* wrangler([
            "kv",
            "namespace",
            "delete",
            "--namespace-id",
            kv.id,
          ])
          done.push(`deleted KV ${kvTitle}`)
        }

        return {
          provider: "cloudflare" as const,
          executed: true,
          actions,
          humanReport: [
            `Cloudflare backend torn down:`,
            ``,
            ...done.map((d) => `  ✓ ${d}`),
            ``,
            `Note: Cloudflare Access service tokens (if any) are not deleted —`,
            `remove them via the Zero Trust dashboard.`,
          ].join("\n"),
        }
      })

    // Local: fully self-contained, so `init` only scaffolds config + .afk.env +
    // .gitignore (no cloud bucket, no Terraform module, no Worker). The Golden
    // Image is still built explicitly via `afk golden build`.
    const initLocal = (
      input: InitInput,
    ): Effect.Effect<InitResult, UserError> =>
      Effect.gen(function* () {
        const { projectDir } = input
        const originUrl = yield* detectOriginUrl(projectDir, sub.run)
        const configPath = resolve(projectDir, CONFIG_FILE)
        let configCreated = false
        let configAction: string
        if (!existsSync(configPath)) {
          writeFileSync(
            configPath,
            JSON.stringify(
              {
                backend: "local",
                gitUrl: originUrl ?? "",
                mainService: "agent",
                defaultTimeoutHours: 4,
                local: { cachedImages: [] as string[] },
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
            local?: Record<string, unknown>
            [k: string]: unknown
          }
          const hadLocal = existing.local !== undefined
          const wasBackend = existing.backend
          existing.backend = "local"
          if (
            (existing.gitUrl === undefined || existing.gitUrl === "") &&
            originUrl !== null
          ) {
            existing.gitUrl = originUrl
          }
          existing.local = { cachedImages: [], ...(existing.local ?? {}) }
          writeFileSync(configPath, JSON.stringify(existing, null, 2) + "\n")
          configAction = hadLocal
            ? "updated local block"
            : `added local block (backend ${wasBackend ?? "?"} → local)`
        }

        const envCreated = upsertEnvFile(projectDir, originUrl)
        const gitignoreUpdated = upsertGitignore(projectDir)

        const status = (b: boolean) => (b ? "created" : "already present")
        const humanReport = [
          `afk.config.json    ${configAction}`,
          `.afk.env           ${status(envCreated)}`,
          `.gitignore         ${gitignoreUpdated ? "updated" : "already had .afk.env / .afk/"}`,
          ``,
          `The Local Backend runs each Run inside rootless dind on your own`,
          `Docker daemon — no cloud resources are provisioned.`,
          ``,
          `Next:`,
          `  1. afk provision        # no-op on local (nothing to stand up)`,
          `  2. afk golden build     # build the local Golden Image (dind + cache)`,
          `  3. afk secrets put github-token <PAT>`,
          `  4. afk run "<your command>"`,
        ].join("\n")

        return {
          provider: "local" as const,
          configCreated,
          envCreated,
          gitignoreUpdated,
          humanReport,
        }
      })

    // Local teardown removes only the per-machine state under ~/.afk (history,
    // secrets, run scratch) and the local Golden Image(s). Live Runs are plain
    // containers the developer can `afk kill`; we don't reach into the daemon
    // here. Self-contained: no cloud calls.
    const destroyLocal = (
      input: DestroyInput,
    ): Effect.Effect<DestroyResult, never> =>
      Effect.sync(() => {
        const actions = [
          "remove local Golden Image(s) (docker rmi afk-golden-local:*)",
          "delete per-machine state under ~/.afk (history, secrets, run scratch)",
        ]
        if (!input.execute) {
          return {
            provider: "local" as const,
            executed: false,
            actions,
            humanReport: [
              `Would tear down the Local Backend (re-run with --yes to execute):`,
              ``,
              ...actions.map((a) => `  ${a}`),
              ``,
              `Live Runs are ordinary containers — stop them with \`afk kill <run>\`.`,
            ].join("\n"),
          }
        }
        return {
          provider: "local" as const,
          executed: true,
          actions,
          humanReport: [
            `Local backend teardown is manual to avoid surprises:`,
            ``,
            `  docker rmi $(docker images 'afk-golden-local' -q)   # Golden Image(s)`,
            `  rm -rf ~/.afk                                       # history + secrets`,
            ``,
            `Live Runs (if any) are ordinary containers — \`afk kill <run>\`.`,
          ].join("\n"),
        }
      })

    // Resolve the active gcloud project without taking a hard dependency on the
    // GCP Auth adapter (keeps initGcp's error channel to UserError). Best-effort:
    // an unset project yields "" so the caller can scaffold with a placeholder
    // rather than fail outright.
    const resolveGcpProject = sub
      .run("gcloud", ["config", "get-value", "project", "--quiet"])
      .pipe(
        Effect.map((r) => r.stdout.trim()),
        Effect.map((p) => (p === "" || p === "(unset)" ? "" : p)),
        Effect.catchAll(() => Effect.succeed("")),
      )

    // GCP init mirrors initAws: scaffold the config block, copy the terraform/gcp
    // module into the project, render the GCS-backed backend.tf, and create the
    // remote-state bucket up front (the gcs backend can't initialise against a
    // missing bucket, and the module deliberately doesn't manage it — same split
    // as AWS's S3 state bucket). Bucket creation is best-effort: an unset gcloud
    // project leaves a placeholder for the developer to fill, and an
    // already-existing bucket is fine.
    const initGcp = (input: InitInput): Effect.Effect<InitResult, UserError> =>
      Effect.gen(function* () {
        const { region, projectDir } = input
        const originUrl = yield* detectOriginUrl(projectDir, sub.run)
        const projectId = yield* resolveGcpProject
        const stateBucket =
          projectId === ""
            ? "REPLACE_WITH_TF_STATE_BUCKET"
            : `${GCP_STATE_BUCKET_PREFIX}-${projectId}`

        let stateBucketCreated = false
        if (projectId !== "") {
          const created = yield* sub
            .run("gcloud", [
              "storage",
              "buckets",
              "create",
              `gs://${stateBucket}`,
              `--project=${projectId}`,
              `--location=${region}`,
              "--uniform-bucket-level-access",
              "--public-access-prevention",
            ])
            .pipe(
              Effect.as(true),
              // Already-exists (409) or insufficient perms shouldn't abort init —
              // the developer can create it by hand; surface it in the report.
              Effect.catchAll(() => Effect.succeed(false)),
            )
          stateBucketCreated = created
          if (created) {
            yield* sub
              .run("gcloud", [
                "storage",
                "buckets",
                "update",
                `gs://${stateBucket}`,
                "--versioning",
              ])
              .pipe(Effect.catchAll(() => Effect.void))
          }
        }

        const terraformDir = resolve(projectDir, "terraform", "gcp")
        const terraformDirCreated = !existsSync(terraformDir)
        if (existsSync(TEMPLATE_GCP_TERRAFORM_DIR)) {
          mkdirSync(terraformDir, { recursive: true })
          yield* Effect.try({
            try: () => {
              cpSync(TEMPLATE_GCP_TERRAFORM_DIR, terraformDir, {
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
            `  backend "gcs" {`,
            `    bucket = "${stateBucket}"`,
            `    prefix = "afk/terraform.tfstate"`,
            `  }`,
            `}`,
            ``,
          ].join("\n")
          writeFileSync(resolve(terraformDir, "backend.tf"), backendTf)
        }

        const configPath = resolve(projectDir, CONFIG_FILE)
        // Default the zone to the first zone of the chosen region, not the
        // module-wide GCP_DEFAULT_ZONE — otherwise `afk init --region eu-west1`
        // scaffolds zone "us-central1-a" and every subsequent gcloud call
        // explodes with a region/zone mismatch.
        const zoneDefault = `${region}-a`
        const gcpBlock = {
          ...(projectId === "" ? {} : { projectId }),
          region,
          zone: zoneDefault,
          defaultMachineType: GCP_DEFAULT_MACHINE_TYPE,
          allowedMachineTypes: [...GCP_DEFAULT_ALLOWED_MACHINE_TYPES],
          cachedImages: [] as string[],
        }
        let configCreated = false
        let configAction: string
        if (!existsSync(configPath)) {
          writeFileSync(
            configPath,
            JSON.stringify(
              {
                backend: "gcp",
                gitUrl: originUrl ?? "",
                mainService: "agent",
                defaultTimeoutHours: 4,
                gcp: gcpBlock,
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
            gcp?: Record<string, unknown>
            [k: string]: unknown
          }
          const hadGcp = existing.gcp !== undefined
          const wasBackend = existing.backend
          existing.backend = "gcp"
          if (
            (existing.gitUrl === undefined || existing.gitUrl === "") &&
            originUrl !== null
          ) {
            existing.gitUrl = originUrl
          }
          // Preserve any values the developer already set; only fill defaults.
          const merged = { ...gcpBlock, ...(existing.gcp ?? {}) }
          // The chosen --region overrides whatever's persisted (it's what the
          // user just typed); a zone that doesn't sit inside it would always
          // fail at gcloud call time, so realign it to the region default.
          merged.region = region
          if (
            typeof merged.zone !== "string" ||
            !merged.zone.startsWith(`${region}-`)
          ) {
            merged.zone = zoneDefault
          }
          existing.gcp = merged
          writeFileSync(configPath, JSON.stringify(existing, null, 2) + "\n")
          configAction = hadGcp
            ? "updated gcp block"
            : `added gcp block (backend ${wasBackend ?? "?"} → gcp)`
        }

        const envCreated = upsertEnvFile(projectDir, originUrl)
        const gitignoreUpdated = upsertGitignore(projectDir)

        const status = (b: boolean) => (b ? "created" : "already present")
        const projectNote =
          projectId === ""
            ? `  ⚠ gcloud project not set — set it (\`gcloud config set project <id>\`),\n    then fill projectId in afk.config.json, create the state bucket\n    (\`gcloud storage buckets create gs://${stateBucket}\`), and fix terraform/gcp/backend.tf`
            : `  project            ${projectId}`
        const stateBucketStatus =
          projectId === ""
            ? "unresolved (gcloud project not set)"
            : stateBucketCreated
              ? "created"
              : "already present or not creatable (check perms)"
        const humanReport = [
          `terraform dir      ${terraformDir} (${status(terraformDirCreated)})`,
          `state bucket       ${stateBucket} (${stateBucketStatus})`,
          `afk.config.json    ${configAction}`,
          `.afk.env           ${status(envCreated)}`,
          `.gitignore         ${gitignoreUpdated ? "updated" : "already had .afk.env / .afk/"}`,
          projectNote,
          ``,
          `Next:`,
          `  1. afk provision              # terraform init + apply (VPC, IAM, Firestore, buckets, sweeper)`,
          `                                #   or run terraform yourself in ${terraformDir}`,
          `  2. afk golden build           # one-time golden custom-image build`,
          `  3. afk secrets put github-token <PAT>`,
          `  4. afk run "<your command>"`,
        ].join("\n")

        return {
          provider: "gcp" as const,
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

    // GCP teardown runs `terraform destroy` in the project's terraform/gcp dir.
    // Golden custom images and Secret Manager secrets live outside the module
    // (built/created by `afk golden build` / `afk secrets put`), so they are
    // surfaced as manual follow-ups rather than deleted here.
    const destroyGcp = (
      input: DestroyInput,
    ): Effect.Effect<DestroyResult, UserError | SubprocessError> =>
      Effect.gen(function* () {
        const { region, projectDir, execute } = input
        const projectId = yield* resolveGcpProject
        const terraformDir = resolve(projectDir, "terraform", "gcp")
        const hasTerraform = existsSync(terraformDir)

        const actions = [
          hasTerraform
            ? `terraform destroy in ${terraformDir} (VPC, IAM, Firestore, buckets, reconcile function)`
            : `no terraform/gcp dir — skipping terraform destroy`,
          `delete golden custom image(s) in family afk-golden (afk golden rm)`,
          `delete Secret Manager secrets under afk-secret-* (afk secrets rm)`,
        ]

        if (!execute) {
          const humanReport = [
            `DRY RUN — nothing has been deleted.`,
            `Backend: gcp   Region: ${region}   Project: ${projectId || "(unset)"}`,
            ``,
            `Would perform:`,
            ...actions.map((a, i) => `  ${i + 1}. ${a}`),
            ``,
            `Re-run with --yes to execute. This is irreversible.`,
          ].join("\n")
          return {
            provider: "gcp" as const,
            executed: false,
            actions,
            humanReport,
          }
        }

        if (projectId === "") {
          return yield* Effect.fail(
            new UserError({
              message: `No active gcloud project — cannot terraform destroy the GCP backend.`,
              hint: "Run `gcloud config set project <id>` first.",
            }),
          )
        }

        const done: string[] = []
        if (hasTerraform) {
          yield* terraform.destroy({
            dir: terraformDir,
            vars: { project_id: projectId, region },
          })
          done.push(`terraform destroy completed`)
        }

        const humanReport = [
          `Teardown complete (backend: gcp, project: ${projectId}).`,
          ``,
          ...done.map((d) => `  - ${d}`),
          ``,
          `Manual follow-ups (outside the terraform module):`,
          `  - golden images:  afk golden ls && afk golden rm <id>`,
          `  - secrets:        afk secrets ls && afk secrets rm <name>`,
          ``,
          `Local files (terraform/gcp/, afk.config.json, .afk.env) were left in place.`,
        ].join("\n")

        return {
          provider: "gcp" as const,
          executed: true,
          actions: done,
          humanReport,
        }
      })

    return BootstrapService.of({
      init: (input) =>
        input.provider === "cloudflare"
          ? initCloudflare(input)
          : input.provider === "local"
            ? initLocal(input)
            : input.provider === "gcp"
              ? initGcp(input)
              : initAws(input),
      destroy: (input) =>
        input.provider === "cloudflare"
          ? destroyCloudflare(input)
          : input.provider === "local"
            ? destroyLocal(input)
            : input.provider === "gcp"
              ? destroyGcp(input)
              : destroyAws(input),
    })
  }),
)
