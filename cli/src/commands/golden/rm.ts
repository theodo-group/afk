import { Args, Command } from "@effect/cli"
import { Effect } from "effect"
import { ImageService } from "../../services/ImageService.ts"
import { CloudflareGoldenBuilder } from "../../services/CloudflareGoldenBuilder.ts"
import { ConfigService } from "../../services/ConfigService.ts"
import { Output } from "../../infra/Output.ts"
import { DEFAULT_REGION } from "../../constants.ts"

// Naming-wise on CF this is a tag, on AWS it's an AMI id. The arg is a free
// string so either fits — the dispatch below routes to the right impl.
const target = Args.text({ name: "ami-id-or-tag" })

export const goldenRm = Command.make("rm", { imageId: target }, ({ imageId }) =>
  Effect.gen(function* () {
    const cfg = yield* ConfigService
    const out = yield* Output
    const { config } = yield* cfg.load
    const backend = config.backend ?? "aws"

    if (backend === "cloudflare") {
      const builder = yield* CloudflareGoldenBuilder
      yield* builder.remove(imageId)
      yield* out.print(`Removed ${imageId}.`)
      return
    }

    const images = yield* ImageService
    const region = config.aws?.region ?? DEFAULT_REGION
    yield* images.remove(region, imageId)
    yield* out.print(`Deregistered ${imageId}.`)
  }),
)
