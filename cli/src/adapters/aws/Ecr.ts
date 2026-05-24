import { Context, Effect, Layer } from "effect"
import { Subprocess } from "../../infra/Subprocess.ts"
import { AwsError } from "../../infra/Errors.ts"
import { makeAwsCli } from "./awsCli.ts"

export class Ecr extends Context.Tag("Ecr")<
  Ecr,
  {
    readonly registryUri: (region: string) => Effect.Effect<string, AwsError>
    readonly ensureRepository: (
      region: string,
      repoName: string,
      lifecycleDays: number,
    ) => Effect.Effect<void, AwsError>
    readonly imageExists: (
      region: string,
      repoName: string,
      tag: string,
    ) => Effect.Effect<boolean, AwsError>
    /** Latest pushed image tag matching `<prefix>*`, newest first, by pushed-at. Empty array if none. */
    readonly listLatestTagsByPrefix: (
      region: string,
      repoName: string,
      tagPrefix: string,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<string>, AwsError>
    readonly getLoginPassword: (
      region: string,
    ) => Effect.Effect<string, AwsError>
    /** Delete a repository and all images in it. No-op-safe if absent. */
    readonly deleteRepository: (
      region: string,
      repoName: string,
    ) => Effect.Effect<void, AwsError>
  }
>() {}

export const EcrLive = Layer.effect(
  Ecr,
  Effect.gen(function* () {
    const sub = yield* Subprocess
    const aws = makeAwsCli(sub)

    return Ecr.of({
      registryUri: (region) =>
        aws
          .json<{ Account: string }>("sts:GetCallerIdentity", [
            "sts",
            "get-caller-identity",
          ])
          .pipe(
            Effect.map((r) => `${r.Account}.dkr.ecr.${region}.amazonaws.com`),
          ),
      ensureRepository: (region, repoName, lifecycleDays) =>
        Effect.gen(function* () {
          const exists = yield* aws.exists([
            "ecr",
            "describe-repositories",
            "--region",
            region,
            "--repository-names",
            repoName,
          ])
          if (!exists) {
            yield* aws.run("ecr:CreateRepository", [
              "ecr",
              "create-repository",
              "--region",
              region,
              "--repository-name",
              repoName,
              "--image-scanning-configuration",
              "scanOnPush=true",
            ])
            const policy = {
              rules: [
                {
                  rulePriority: 1,
                  description: `expire after ${lifecycleDays} days`,
                  selection: {
                    tagStatus: "any",
                    countType: "sinceImagePushed",
                    countUnit: "days",
                    countNumber: lifecycleDays,
                  },
                  action: { type: "expire" },
                },
              ],
            }
            yield* aws.run("ecr:PutLifecyclePolicy", [
              "ecr",
              "put-lifecycle-policy",
              "--region",
              region,
              "--repository-name",
              repoName,
              "--lifecycle-policy-text",
              JSON.stringify(policy),
            ])
          }
        }),
      imageExists: (region, repoName, tag) =>
        aws.exists([
          "ecr",
          "describe-images",
          "--region",
          region,
          "--repository-name",
          repoName,
          "--image-ids",
          `imageTag=${tag}`,
        ]),
      listLatestTagsByPrefix: (region, repoName, tagPrefix, limit) =>
        aws
          .json<{
            imageDetails: ReadonlyArray<{
              imageTags?: ReadonlyArray<string>
              imagePushedAt?: string
            }>
          }>("ecr:DescribeImages", [
            "ecr",
            "describe-images",
            "--region",
            region,
            "--repository-name",
            repoName,
          ])
          .pipe(
            Effect.map((r) =>
              (r.imageDetails ?? [])
                .filter((d) =>
                  (d.imageTags ?? []).some((t) => t.startsWith(tagPrefix)),
                )
                .sort((a, b) =>
                  (b.imagePushedAt ?? "").localeCompare(a.imagePushedAt ?? ""),
                )
                .flatMap((d) =>
                  (d.imageTags ?? []).filter((t) => t.startsWith(tagPrefix)),
                )
                .slice(0, limit),
            ),
            // Repo may not exist yet on first build; that's fine.
            Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<string>)),
          ),
      getLoginPassword: (region) =>
        aws.text("ecr:GetAuthorizationToken", [
          "ecr",
          "get-login-password",
          "--region",
          region,
        ]),
      deleteRepository: (region, repoName) =>
        aws
          .run("ecr:DeleteRepository", [
            "ecr",
            "delete-repository",
            "--region",
            region,
            "--repository-name",
            repoName,
            "--force",
          ])
          .pipe(
            // Already gone (RepositoryNotFoundException) is success for teardown.
            Effect.catchAll((e) =>
              e.message.includes("RepositoryNotFoundException")
                ? Effect.void
                : Effect.fail(e),
            ),
          ),
    })
  }),
)
