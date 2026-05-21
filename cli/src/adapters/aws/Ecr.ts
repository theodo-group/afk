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
      repoName: string,
      lifecycleDays: number,
    ) => Effect.Effect<void, AwsError>
    readonly imageExists: (
      repoName: string,
      tag: string,
    ) => Effect.Effect<boolean, AwsError>
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
      ensureRepository: (repoName, lifecycleDays) =>
        Effect.gen(function* () {
          const exists = yield* sub
            .runJson<{ repositories: ReadonlyArray<{ repositoryName: string }> }>(
              "aws",
              [
                "ecr",
                "describe-repositories",
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
      imageExists: (repoName, tag) =>
        sub
          .run("aws", [
            "ecr",
            "describe-images",
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
