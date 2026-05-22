import { Context, Effect, Layer } from "effect"
import { Subprocess } from "../../infra/Subprocess.ts"
import { AwsError } from "../../infra/Errors.ts"

const awsError = (op: string) => (e: { _tag: string; stderr?: string; cause?: unknown }) =>
  new AwsError({
    operation: op,
    message: e._tag === "ParseError" ? String(e.cause) : (e.stderr ?? ""),
  })

export class S3 extends Context.Tag("S3")<
  S3,
  {
    readonly bucketExists: (
      bucket: string,
    ) => Effect.Effect<boolean, AwsError>
    readonly createStateBucket: (input: {
      readonly bucket: string
      readonly region: string
    }) => Effect.Effect<void, AwsError>
  }
>() {}

export const S3Live = Layer.effect(
  S3,
  Effect.gen(function* () {
    const sub = yield* Subprocess

    return S3.of({
      bucketExists: (bucket) =>
        sub
          .run("aws", ["s3api", "head-bucket", "--bucket", bucket])
          .pipe(
            Effect.map(() => true),
            Effect.catchAll(() => Effect.succeed(false)),
          ),
      createStateBucket: ({ bucket, region }) =>
        Effect.gen(function* () {
          const createArgs =
            region === "us-east-1"
              ? ["s3api", "create-bucket", "--bucket", bucket, "--region", region]
              : [
                  "s3api",
                  "create-bucket",
                  "--bucket",
                  bucket,
                  "--region",
                  region,
                  "--create-bucket-configuration",
                  `LocationConstraint=${region}`,
                ]
          yield* sub
            .run("aws", createArgs)
            .pipe(Effect.mapError(awsError("s3:CreateBucket")))
          yield* sub
            .run("aws", [
              "s3api",
              "put-bucket-versioning",
              "--bucket",
              bucket,
              "--region",
              region,
              "--versioning-configuration",
              "Status=Enabled",
            ])
            .pipe(
              Effect.asVoid,
              Effect.mapError(awsError("s3:PutBucketVersioning")),
            )
          yield* sub
            .run("aws", [
              "s3api",
              "put-bucket-encryption",
              "--bucket",
              bucket,
              "--region",
              region,
              "--server-side-encryption-configuration",
              JSON.stringify({
                Rules: [
                  {
                    ApplyServerSideEncryptionByDefault: {
                      SSEAlgorithm: "AES256",
                    },
                  },
                ],
              }),
            ])
            .pipe(
              Effect.asVoid,
              Effect.mapError(awsError("s3:PutBucketEncryption")),
            )
          yield* sub
            .run("aws", [
              "s3api",
              "put-public-access-block",
              "--bucket",
              bucket,
              "--region",
              region,
              "--public-access-block-configuration",
              "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true",
            ])
            .pipe(
              Effect.asVoid,
              Effect.mapError(awsError("s3:PutPublicAccessBlock")),
            )
        }),
    })
  }),
)
