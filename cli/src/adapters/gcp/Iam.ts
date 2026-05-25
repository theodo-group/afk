import { Context, Effect, Layer } from "effect"
import { Subprocess } from "../../infra/Subprocess.ts"
import { GcpError } from "../../infra/Errors.ts"
import { makeGcloudCli } from "./gcloudCli.ts"

/**
 * Project IAM-policy-binding adapter — the GCP analogue of `Iam`. The GCP
 * Backend never *creates* principals; it binds/unbinds existing org members to
 * the project-level `afk-developer` role. Tagged `GcpIam` to avoid clashing with
 * the AWS `Iam` Context.Tag string.
 */
export class GcpIam extends Context.Tag("GcpIam")<
  GcpIam,
  {
    readonly addBinding: (
      project: string,
      member: string,
      role: string,
    ) => Effect.Effect<void, GcpError>
    readonly removeBinding: (
      project: string,
      member: string,
      role: string,
    ) => Effect.Effect<void, GcpError>
    /** Members bound to `role` on the project. */
    readonly listBindings: (
      project: string,
      role: string,
    ) => Effect.Effect<ReadonlyArray<string>, GcpError>
  }
>() {}

interface PolicyBinding {
  readonly role: string
  readonly members?: ReadonlyArray<string>
}

export const GcpIamLive = Layer.effect(
  GcpIam,
  Effect.gen(function* () {
    const sub = yield* Subprocess
    const gcloud = makeGcloudCli(sub)

    const addBinding = (project: string, member: string, role: string) =>
      gcloud.run("projects:add-iam-policy-binding", [
        "projects",
        "add-iam-policy-binding",
        project,
        `--member=${member}`,
        `--role=${role}`,
      ])

    const removeBinding = (project: string, member: string, role: string) =>
      gcloud.run("projects:remove-iam-policy-binding", [
        "projects",
        "remove-iam-policy-binding",
        project,
        `--member=${member}`,
        `--role=${role}`,
      ])

    const listBindings = (project: string, role: string) =>
      gcloud
        .json<{ bindings?: ReadonlyArray<PolicyBinding> }>(
          "projects:get-iam-policy",
          ["projects", "get-iam-policy", project],
        )
        .pipe(
          Effect.map((policy) =>
            (policy.bindings ?? [])
              .filter((b) => b.role === role)
              .flatMap((b) => b.members ?? []),
          ),
        )

    return GcpIam.of({ addBinding, removeBinding, listBindings })
  }),
)
