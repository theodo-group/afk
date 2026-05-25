import { Effect, Layer } from "effect"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { resolve } from "node:path"
import { ConfigService } from "../../services/ConfigService.ts"
import { Auth } from "../../adapters/gcp/Auth.ts"
import { Terraform } from "../../adapters/Terraform.ts"
import { Output } from "../../infra/Output.ts"
import { UserError } from "../../infra/Errors.ts"
import { Provisioner } from "../../services/backend/Provisioner.ts"
import { GCP_DEFAULT_REGION, GCP_DEFAULT_ZONE } from "../../constants.ts"

/**
 * Read the quota_project_id baked into the developer's Application Default
 * Credentials. Terraform's google provider authenticates via ADC; when the
 * ADC's quota project doesn't match the project we're applying into, every
 * API call comes back as a 403 "billing account ... disabled in state absent"
 * — confusing and unrelated to the project's actual billing state.
 *
 * Returns `null` when there is no `application_default_credentials.json`,
 * when the JSON is unparseable, or when it has no `quota_project_id` field
 * (in any of which cases we leave the developer to whatever default gcloud
 * picks — we only fail fast when the file exists and explicitly mismatches).
 */
const readAdcQuotaProject = (): string | null => {
  const candidates = [
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
    resolve(homedir(), ".config", "gcloud", "application_default_credentials.json"),
  ].filter((p): p is string => typeof p === "string" && p.length > 0)
  for (const path of candidates) {
    if (!existsSync(path)) continue
    try {
      const adc = JSON.parse(readFileSync(path, "utf8")) as {
        quota_project_id?: unknown
      }
      if (typeof adc.quota_project_id === "string") return adc.quota_project_id
    } catch {
      // Unparseable ADC file isn't our problem to diagnose here.
    }
  }
  return null
}

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

      // Pre-flight: ADC quota project must match the target project, else
      // `terraform apply` fails inside the gcs backend's first state read
      // with a 403 that reads like a billing problem ("billing account …
      // disabled in state absent"). Surface a one-liner fix instead.
      const adcQuotaProject = readAdcQuotaProject()
      if (adcQuotaProject !== null && adcQuotaProject !== project) {
        return yield* Effect.fail(
          new UserError({
            message: `Application Default Credentials quota project (${adcQuotaProject}) does not match afk.config.json gcp.projectId (${project}).`,
            hint: `Run: gcloud auth application-default set-quota-project ${project}`,
          }),
        )
      }
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
