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
/**
 * An IAM condition (CEL) attached to a role binding. Mirrors terraform's
 * `condition { title, description, expression }`. When a member is bound with
 * the same condition text as an existing binding, gcloud merges them into that
 * binding group.
 */
export interface IamCondition {
  readonly title: string
  readonly description: string
  readonly expression: string
}

export class GcpIam extends Context.Tag("GcpIam")<
  GcpIam,
  {
    readonly addBinding: (
      project: string,
      member: string,
      role: string,
      condition?: IamCondition,
    ) => Effect.Effect<void, GcpError>
    /**
     * Bind `member` to `role` on a service-account resource (not the project) —
     * e.g. `roles/iam.serviceAccountUser` so a developer may actAs the afk-vm SA.
     * `project` is passed explicitly: gcloud otherwise resolves the SA against
     * the active gcloud project, which need not be the afk project.
     */
    readonly addServiceAccountBinding: (
      project: string,
      serviceAccount: string,
      member: string,
      role: string,
    ) => Effect.Effect<void, GcpError>
    readonly removeBinding: (
      project: string,
      member: string,
      role: string,
      condition?: IamCondition,
    ) => Effect.Effect<void, GcpError>
    readonly removeServiceAccountBinding: (
      project: string,
      serviceAccount: string,
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

    // gcloud refuses to add a binding without `--condition` once the policy
    // already contains any conditional binding; `--condition=None` is the
    // explicit "no condition" form. When a condition is supplied it is passed
    // inline as `title=…,description=…,expression=…` (gcloud splits the value on
    // commas, so none of the three fields may contain a comma).
    const conditionArg = (condition?: IamCondition) =>
      condition
        ? `--condition=title=${condition.title},description=${condition.description},expression=${condition.expression}`
        : "--condition=None"

    const addBinding = (
      project: string,
      member: string,
      role: string,
      condition?: IamCondition,
    ) =>
      gcloud.run("projects:add-iam-policy-binding", [
        "projects",
        "add-iam-policy-binding",
        project,
        `--member=${member}`,
        `--role=${role}`,
        conditionArg(condition),
      ])

    const addServiceAccountBinding = (
      project: string,
      serviceAccount: string,
      member: string,
      role: string,
    ) =>
      gcloud.run("iam:service-accounts:add-iam-policy-binding", [
        "iam",
        "service-accounts",
        "add-iam-policy-binding",
        serviceAccount,
        `--project=${project}`,
        `--member=${member}`,
        `--role=${role}`,
        "--condition=None",
      ])

    const removeBinding = (
      project: string,
      member: string,
      role: string,
      condition?: IamCondition,
    ) =>
      gcloud.run("projects:remove-iam-policy-binding", [
        "projects",
        "remove-iam-policy-binding",
        project,
        `--member=${member}`,
        `--role=${role}`,
        conditionArg(condition),
      ])

    const removeServiceAccountBinding = (
      project: string,
      serviceAccount: string,
      member: string,
      role: string,
    ) =>
      gcloud.run("iam:service-accounts:remove-iam-policy-binding", [
        "iam",
        "service-accounts",
        "remove-iam-policy-binding",
        serviceAccount,
        `--project=${project}`,
        `--member=${member}`,
        `--role=${role}`,
        "--condition=None",
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

    return GcpIam.of({
      addBinding,
      addServiceAccountBinding,
      removeBinding,
      removeServiceAccountBinding,
      listBindings,
    })
  }),
)
