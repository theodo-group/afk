import { Command } from "@effect/cli"
import { Effect } from "effect"
import { Output } from "../infra/Output.ts"
import { Provisioner } from "../services/backend/Provisioner.ts"

/**
 * `afk provision` — runs the one-time backing-infra setup for the active
 * Backend, so the developer never leaves the `afk` CLI. The per-Backend work
 * (AWS Terraform, the Cloudflare wrangler dance, the Local no-op) lives behind
 * the `Provisioner` seam; this command just renders the report it returns.
 */
export const provision = Command.make("provision", {}, () =>
  Effect.gen(function* () {
    const out = yield* Output
    const provisioner = yield* Provisioner

    const report = yield* provisioner.provision

    yield* out.emit({
      data: report.details,
      human: () =>
        out.print(
          [report.summary, ``, `Next:`, ...report.nextSteps.map((s) => `  ${s}`)].join(
            "\n",
          ),
        ),
    })
  }),
)
