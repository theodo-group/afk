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
    /**
     * Empty a (possibly versioned) bucket — deleting every object version and
     * delete-marker — then delete the bucket itself. No-op-safe if the bucket
     * is already gone.
     */
    readonly emptyAndDeleteBucket: (input: {
      readonly bucket: string
      readonly region: string
    }) => Effect.Effect<void, AwsError>
  }
>() {}

interface ObjectVersion {
  readonly Key: string
  readonly VersionId?: string
}

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
      emptyAndDeleteBucket: ({ bucket, region }) =>
        Effect.gen(function* () {
          // List every version + delete-marker. On a non-versioned bucket the
          // Versions array still carries the live objects.
          const listing = yield* sub
            .runJson<{
              Versions?: ReadonlyArray<ObjectVersion>
              DeleteMarkers?: ReadonlyArray<ObjectVersion>
            }>("aws", [
              "s3api",
              "list-object-versions",
              "--bucket",
              bucket,
              "--region",
              region,
              "--output",
              "json",
            ])
            .pipe(
              Effect.catchAll(() =>
                Effect.succeed(
                  {} as {
                    Versions?: ReadonlyArray<ObjectVersion>
                    DeleteMarkers?: ReadonlyArray<ObjectVersion>
                  },
                ),
              ),
            )

          const objects = [
            ...(listing.Versions ?? []),
            ...(listing.DeleteMarkers ?? []),
          ].map((o) => ({ Key: o.Key, VersionId: o.VersionId }))

          // delete-objects caps at 1000 keys per call.
          for (let i = 0; i < objects.length; i += 1000) {
            const batch = objects.slice(i, i + 1000)
            yield* sub
              .run("aws", [
                "s3api",
                "delete-objects",
                "--bucket",
                bucket,
                "--region",
                region,
                "--delete",
                JSON.stringify({ Objects: batch, Quiet: true }),
                "--output",
                "json",
              ])
              .pipe(Effect.asVoid, Effect.mapError(awsError("s3:DeleteObjects")))
          }

          yield* sub
            .run("aws", [
              "s3api",
              "delete-bucket",
              "--bucket",
              bucket,
              "--region",
              region,
            ])
            .pipe(Effect.asVoid, Effect.mapError(awsError("s3:DeleteBucket")))
        }),
    })
  }),
)
