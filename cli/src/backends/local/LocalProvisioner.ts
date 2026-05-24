import { Effect, Layer } from "effect"
import { Provisioner } from "../../services/backend/Provisioner.ts"

/**
 * The Local Backend is self-contained — there is no backing infra to stand up.
 * It still answers `afk provision` cleanly (rather than erroring or being
 * absent) so the uniform init → provision → golden build arc holds on Local.
 */
export const LocalProvisionerLive = Layer.succeed(
  Provisioner,
  Provisioner.of({
    provision: Effect.succeed({
      summary: "Nothing to provision on the Local Backend.",
      details: { backend: "local", provisioned: false },
      nextSteps: [
        "afk golden build                     # build the local Golden Image",
        "afk secrets put github-token <PAT>   # so Runs can clone source",
        'afk run "<command>"',
      ],
    }),
  }),
)
