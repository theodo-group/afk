import { Effect, Layer } from "effect"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { ConfigService } from "../../services/ConfigService.ts"
import { Terraform } from "../../adapters/Terraform.ts"
import { Output } from "../../infra/Output.ts"
import { UserError } from "../../infra/Errors.ts"
import { Provisioner } from "../../services/backend/Provisioner.ts"
import { ensureBackendRegionMatches } from "../../services/TerraformBackend.ts"
import { DEFAULT_REGION } from "../../constants.ts"

/**
 * AWS provisioning is the Terraform module `afk init` dropped at
 * `terraform/afk` — run it (init + apply) for the developer instead of making
 * them `cd` + `terraform`.
 */
export const AwsProvisionerLive = Layer.effect(
  Provisioner,
  Effect.gen(function* () {
    const cfg = yield* ConfigService
    const tf = yield* Terraform
    const out = yield* Output

    const provision = Effect.gen(function* () {
      const { config, projectRoot } = yield* cfg.load
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
      yield* ensureBackendRegionMatches({
        terraformDir: dir,
        configRegion: region,
      })
      yield* out.print(`• terraform init + apply (region ${region})…`)
      yield* tf.apply({ dir, vars: { aws_region: region } })

      return {
        summary:
          "✓ AWS backend provisioned (VPC, IAM, sweeper Lambda, DynamoDB).",
        details: { backend: "aws", region, terraformDir: dir },
        nextSteps: [
          "afk golden build                     # build the Golden AMI",
          "afk secrets put github-token <PAT>   # so Runs can clone source",
          'afk run "<command>"',
        ],
      }
    })

    return Provisioner.of({ provision })
  }),
)
