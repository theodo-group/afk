import { Effect, Layer } from "effect"
import { AwsComputeLive } from "./AwsCompute.ts"
import { AwsImageRegistryLive } from "./AwsImageRegistry.ts"
import { AwsSecretStoreLive } from "./AwsSecretStore.ts"
import { AwsLogStoreLive } from "./AwsLogStore.ts"
import { AwsRunHistoryLive } from "./AwsRunHistory.ts"
import { CloudflareGoldenBuilder } from "../../services/CloudflareGoldenBuilder.ts"
import { UserError } from "../../infra/Errors.ts"

/**
 * Aggregate Layer that wires up every Backend service tag with the AWS
 * implementation. Selected by `cli.ts` when `afk.config.json` has
 * `backend: "aws"` (the default).
 *
 * AwsComputeLive consumes the `RunHistory` tag internally to record Run starts
 * in DynamoDB. AwsRunHistoryLive provides that tag. To satisfy the intra-merge
 * dependency we wire them via `provideMerge`: AwsRunHistoryLive (and the other
 * leaf adapters that have no intra-backend deps) is provided as input to
 * AwsComputeLive, while still being re-exported in the aggregate output so
 * other services (e.g. SecretService) can consume SecretStore directly.
 */
const Leaves = Layer.mergeAll(
  AwsImageRegistryLive,
  AwsSecretStoreLive,
  AwsLogStoreLive,
  AwsRunHistoryLive,
)

/**
 * Stub `CloudflareGoldenBuilder` for the AWS aggregate so the shared
 * golden-command dispatch (which references both impls at compile time) has
 * a fully-resolved tag in the AppLive type. The stub fails loudly if the
 * AWS branch ever actually consumes it — that should never happen because
 * the command-level dispatch routes on `config.backend`.
 */
const CloudflareGoldenBuilderStub = Layer.succeed(
  CloudflareGoldenBuilder,
  CloudflareGoldenBuilder.of({
    build: Effect.fail(
      new UserError({
        message:
          "internal: CloudflareGoldenBuilder.build invoked on the AWS backend",
        hint: "This should never happen — file an issue.",
      }),
    ),
    list: Effect.succeed([]),
    remove: () =>
      Effect.fail(
        new UserError({
          message:
            "internal: CloudflareGoldenBuilder.remove invoked on the AWS backend",
        }),
      ),
    findLatest: Effect.succeed(null),
  }),
)

export const AwsBackendLive = Layer.mergeAll(
  AwsComputeLive.pipe(Layer.provideMerge(Leaves)),
  CloudflareGoldenBuilderStub,
)
