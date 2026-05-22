import { Context, Effect, Layer } from "effect"
import { Subprocess } from "../../infra/Subprocess.ts"
import { AwsError } from "../../infra/Errors.ts"

const awsError = (op: string) => (e: { _tag: string; stderr?: string; cause?: unknown }) =>
  new AwsError({
    operation: op,
    message: e._tag === "ParseError" ? String(e.cause) : (e.stderr ?? ""),
  })

export class Ecr extends Context.Tag("Ecr")<
  Ecr,
  {
    readonly registryUri: (
      region: string,
    ) => Effect.Effect<string, AwsError>
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
  }
>() {}

export const EcrLive = Layer.effect(
  Ecr,
  Effect.gen(function* () {
    const sub = yield* Subprocess

    return Ecr.of({
      registryUri: (region) =>
        sub
          .runJson<{ Account: string }>("aws", [
            "sts",
            "get-caller-identity",
            "--output",
            "json",
          ])
          .pipe(
            Effect.map(
              (r) => `${r.Account}.dkr.ecr.${region}.amazonaws.com`,
            ),
            Effect.mapError(awsError("sts:GetCallerIdentity")),
          ),
      ensureRepository: (region, repoName, lifecycleDays) =>
        Effect.gen(function* () {
          const exists = yield* sub
            .runJson<{ repositories: ReadonlyArray<{ repositoryName: string }> }>(
              "aws",
              [
                "ecr",
                "describe-repositories",
                "--region",
                region,
                "--repository-names",
                repoName,
                "--output",
                "json",
              ],
            )
            .pipe(
              Effect.map(() => true),
              Effect.catchAll(() => Effect.succeed(false)),
            )
          if (!exists) {
            yield* sub
              .run("aws", [
                "ecr",
                "create-repository",
                "--region",
                region,
                "--repository-name",
                repoName,
                "--image-scanning-configuration",
                "scanOnPush=true",
                "--output",
                "json",
              ])
              .pipe(Effect.mapError(awsError("ecr:CreateRepository")))
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
            yield* sub
              .run("aws", [
                "ecr",
                "put-lifecycle-policy",
                "--region",
                region,
                "--repository-name",
                repoName,
                "--lifecycle-policy-text",
                JSON.stringify(policy),
                "--output",
                "json",
              ])
              .pipe(
                Effect.asVoid,
                Effect.mapError(awsError("ecr:PutLifecyclePolicy")),
              )
          }
        }),
      imageExists: (region, repoName, tag) =>
        sub
          .run("aws", [
            "ecr",
            "describe-images",
            "--region",
            region,
            "--repository-name",
            repoName,
            "--image-ids",
            `imageTag=${tag}`,
            "--output",
            "json",
          ])
          .pipe(
            Effect.map(() => true),
            Effect.catchAll(() => Effect.succeed(false)),
          ),
      listLatestTagsByPrefix: (region, repoName, tagPrefix, limit) =>
        sub
          .runJson<{
            imageDetails: ReadonlyArray<{
              imageTags?: ReadonlyArray<string>
              imagePushedAt?: string
            }>
          }>("aws", [
            "ecr",
            "describe-images",
            "--region",
            region,
            "--repository-name",
            repoName,
            "--output",
            "json",
          ])
          .pipe(
            Effect.map((r) =>
              (r.imageDetails ?? [])
                .filter((d) => (d.imageTags ?? []).some((t) => t.startsWith(tagPrefix)))
                .sort((a, b) =>
                  (b.imagePushedAt ?? "").localeCompare(a.imagePushedAt ?? ""),
                )
                .flatMap((d) => (d.imageTags ?? []).filter((t) => t.startsWith(tagPrefix)))
                .slice(0, limit),
            ),
            // Repo may not exist yet on first build; that's fine.
            Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<string>)),
          ),
      getLoginPassword: (region) =>
        sub
          .run("aws", ["ecr", "get-login-password", "--region", region])
          .pipe(
            Effect.map((r) => r.stdout.trim()),
            Effect.mapError(awsError("ecr:GetAuthorizationToken")),
          ),
    })
  }),
)
