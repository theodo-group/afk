import { Effect, Layer } from "effect"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { ConfigService } from "../../services/ConfigService.ts"
import { Auth } from "../../adapters/gcp/Auth.ts"
import { Terraform } from "../../adapters/Terraform.ts"
import { Output } from "../../infra/Output.ts"
import { UserError } from "../../infra/Errors.ts"
import { Provisioner } from "../../services/backend/Provisioner.ts"
import { GCP_DEFAULT_REGION, GCP_DEFAULT_ZONE } from "../../constants.ts"

/**
 * GCP provisioning runs the Terraform module dropped at `terraform/gcp` — VPC +
 * Cloud NAT, the instance/developer IAM, Firestore + indexes, the artifacts +
 * state buckets, and the reconcile Cloud Function — for the developer instead of
 * making them `cd` + `terraform`. Streams its steps through the `Output` tag.
 */
export const GcpProvisionerLive = Layer.effect(
  Provisioner,
  Effect.gen(function* () {
    const cfg = yield* ConfigService
    const auth = yield* Auth
    const tf = yield* Terraform
    const out = yield* Output

    const provision = Effect.gen(function* () {
      const { config, projectRoot } = yield* cfg.load
      const dir = resolve(projectRoot, "terraform", "gcp")
      if (!existsSync(dir)) {
        return yield* Effect.fail(
          new UserError({
            message: `no terraform/gcp module at ${dir}.`,
            hint: "Run `afk init --provider gcp` first.",
          }),
        )
      }
      const region = config.gcp?.region ?? GCP_DEFAULT_REGION
      const zone = config.gcp?.zone ?? GCP_DEFAULT_ZONE
      const project = config.gcp?.projectId ?? (yield* auth.activeProject)
      // The afk-developer role + IAP/OS-Login bindings need a concrete member at
      // apply time (terraform/gcp has no default for developer_member). Derive it
      // from the active gcloud principal: a *.gserviceaccount.com account is a
      // service account, everything else a user. `afk team add` adds more later.
      const account = yield* auth.callerAccount
      const developerMember = account.endsWith(".gserviceaccount.com")
        ? `serviceAccount:${account}`
        : `user:${account}`
      yield* out.print(
        `• terraform init + apply (project ${project}, region ${region})…`,
      )
      yield* tf.apply({
        dir,
        vars: {
          project_id: project,
          region,
          zone,
          developer_member: developerMember,
        },
      })

      return {
        summary:
          "✓ GCP backend provisioned (VPC + NAT, IAM, Firestore, buckets, reconcile function).",
        details: { backend: "gcp", project, region, terraformDir: dir },
        nextSteps: [
          "afk golden build                     # build the Golden custom image",
          "afk secrets put github-token <PAT>   # so Runs can clone source",
          'afk run "<command>"',
        ],
      }
    })

    return Provisioner.of({ provision })
  }),
)
