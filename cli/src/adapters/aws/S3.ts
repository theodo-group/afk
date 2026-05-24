import { Context, Effect, Layer } from "effect"
import { Subprocess } from "../../infra/Subprocess.ts"
import { AwsError } from "../../infra/Errors.ts"
import { makeAwsCli } from "./awsCli.ts"

export class S3 extends Context.Tag("S3")<
  S3,
  {
    readonly bucketExists: (bucket: string) => Effect.Effect<boolean, AwsError>
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
    /**
     * Sync an S3 prefix down into a local directory. Uses `aws s3 sync`, which
     * is a no-op (not an error) when the prefix holds no objects — the natural
     * "no Session Artifact for this Run" case.
     */
    readonly downloadPrefix: (input: {
      readonly bucket: string
      readonly prefix: string
      readonly destDir: string
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
    const aws = makeAwsCli(sub)

    return S3.of({
      bucketExists: (bucket) =>
        aws.exists(["s3api", "head-bucket", "--bucket", bucket]),
      createStateBucket: ({ bucket, region }) =>
        Effect.gen(function* () {
          const createArgs =
            region === "us-east-1"
              ? [
                  "s3api",
                  "create-bucket",
                  "--bucket",
                  bucket,
                  "--region",
                  region,
                ]
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
          yield* aws.run("s3:CreateBucket", createArgs)
          yield* aws.run("s3:PutBucketVersioning", [
            "s3api",
            "put-bucket-versioning",
            "--bucket",
            bucket,
            "--region",
            region,
            "--versioning-configuration",
            "Status=Enabled",
          ])
          yield* aws.run("s3:PutBucketEncryption", [
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
          yield* aws.run("s3:PutPublicAccessBlock", [
            "s3api",
            "put-public-access-block",
            "--bucket",
            bucket,
            "--region",
            region,
            "--public-access-block-configuration",
            "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true",
          ])
        }),
      emptyAndDeleteBucket: ({ bucket, region }) =>
        Effect.gen(function* () {
          // List every version + delete-marker. On a non-versioned bucket the
          // Versions array still carries the live objects.
          const listing = yield* aws
            .json<{
              Versions?: ReadonlyArray<ObjectVersion>
              DeleteMarkers?: ReadonlyArray<ObjectVersion>
            }>("s3:ListObjectVersions", [
              "s3api",
              "list-object-versions",
              "--bucket",
              bucket,
              "--region",
              region,
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
            yield* aws.run("s3:DeleteObjects", [
              "s3api",
              "delete-objects",
              "--bucket",
              bucket,
              "--region",
              region,
              "--delete",
              JSON.stringify({ Objects: batch, Quiet: true }),
            ])
          }

          yield* aws.run("s3:DeleteBucket", [
            "s3api",
            "delete-bucket",
            "--bucket",
            bucket,
            "--region",
            region,
          ])
        }),
      downloadPrefix: ({ bucket, prefix, destDir, region }) =>
        aws.run("s3:Sync", [
          "s3",
          "sync",
          `s3://${bucket}/${prefix}`,
          destDir,
          "--region",
          region,
        ]),
    })
  }),
)
