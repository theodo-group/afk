import { Context, Effect, Layer } from "effect"
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  cpSync,
} from "node:fs"
import { resolve } from "node:path"
import { S3 } from "../adapters/aws/S3.ts"
import { Sts } from "../adapters/aws/Sts.ts"
import { AwsError, UserError } from "../infra/Errors.ts"
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

export interface InitInput {
  readonly region: string
  readonly projectDir: string
}

export interface InitResult {
  readonly stateBucket: string
  readonly terraformDir: string
  readonly configCreated: boolean
  readonly envCreated: boolean
}

export class BootstrapService extends Context.Tag("BootstrapService")<
  BootstrapService,
  {
    readonly init: (
      input: InitInput,
    ) => Effect.Effect<InitResult, AwsError | UserError>
  }
>() {}

export const BootstrapServiceLive = Layer.effect(
  BootstrapService,
  Effect.gen(function* () {
    const s3 = yield* S3
    const sts = yield* Sts

    return BootstrapService.of({
      init: ({ region, projectDir }) =>
        Effect.gen(function* () {
          const identity = yield* sts.callerIdentity
          const stateBucket = `${AFK_STATE_BUCKET_PREFIX}-${identity.Account}-${region}`

          const exists = yield* s3.bucketExists(stateBucket)
          if (!exists) {
            yield* s3.createStateBucket({ bucket: stateBucket, region })
          }

          // Copy terraform module into the project
          const terraformDir = resolve(projectDir, "terraform", "afk")
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
            // Render backend.tf with the actual state bucket
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

          // Scaffold config + env
          const configPath = resolve(projectDir, CONFIG_FILE)
          let configCreated = false
          if (!existsSync(configPath)) {
            writeFileSync(
              configPath,
              JSON.stringify(
                {
                  gitUrl: "",
                  defaultCpu: 1024,
                  defaultMemory: 2048,
                  defaultTimeoutHours: 4,
                },
                null,
                2,
              ) + "\n",
            )
            configCreated = true
          }

          const envPath = resolve(projectDir, ENV_FILE)
          let envCreated = false
          if (!existsSync(envPath)) {
            writeFileSync(
              envPath,
              [
                `# Plain values for non-secrets:`,
                `# LOG_LEVEL=debug`,
                `#`,
                `# SSM references for secrets:`,
                `# ANTHROPIC_API_KEY=ssm:/afk/secrets/anthropic-key`,
                `# Use \`afk secrets put <name> <value>\` to store values.`,
                ``,
              ].join("\n"),
            )
            envCreated = true
          }

          // gitignore .afk.env
          const gitignorePath = resolve(projectDir, ".gitignore")
          const gitignoreContents = existsSync(gitignorePath)
            ? require("node:fs").readFileSync(gitignorePath, "utf8")
            : ""
          if (!gitignoreContents.split("\n").includes(ENV_FILE)) {
            appendFileSync(
              gitignorePath,
              (gitignoreContents.endsWith("\n") || gitignoreContents === ""
                ? ""
                : "\n") +
                `${ENV_FILE}\n.afk/\n`,
            )
          }

          return {
            stateBucket,
            terraformDir,
            configCreated,
            envCreated,
          }
        }),
    })
  }),
)
