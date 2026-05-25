import { Context, Effect } from "effect"
import type {
  CloudflareError,
  GcpError,
  ConfigError,
  SubprocessError,
  UserError,
} from "../../infra/Errors.ts"

/**
 * What `afk provision` reports once the active Backend's one-time backing infra
 * is stood up. `details` is the machine-readable `--json` payload; `nextSteps`
 * are the command lines the developer runs next. The command renders all three
 * uniformly, so the per-Backend differences (AWS Terraform vs CF wrangler vs
 * the Local no-op) stay behind this seam.
 */
export interface ProvisionReport {
  readonly summary: string
  readonly details: Readonly<Record<string, string | boolean>>
  readonly nextSteps: ReadonlyArray<string>
}

/**
 * Backend-neutral one-time setup of the backing infra a Run depends on — the
 * AWS Terraform module (VPC, IAM, sweeper Lambda, DynamoDB), the Cloudflare
 * launcher Worker (D1 + KV + deploy + secret), or nothing on Local. Streams its
 * own progress to the user's TTY while running; the returned `ProvisionReport`
 * is the final summary the command emits.
 */
export class Provisioner extends Context.Tag("Provisioner")<
  Provisioner,
  {
    readonly provision: Effect.Effect<
      ProvisionReport,
      ConfigError | UserError | CloudflareError | GcpError | SubprocessError
    >
  }
>() {}
