import { Args, Command } from "@effect/cli"
import { Effect } from "effect"
import { ImageService } from "../../services/ImageService.ts"
import { ConfigService } from "../../services/ConfigService.ts"
import { Output } from "../../infra/Output.ts"
import { DEFAULT_REGION } from "../../constants.ts"

const imageId = Args.text({ name: "ami-id" })

export const imageRm = Command.make("rm", { imageId }, ({ imageId }) =>
  Effect.gen(function* () {
    const images = yield* ImageService
    const cfg = yield* ConfigService
    const out = yield* Output
    const { config } = yield* cfg.load
    const region = config.aws?.region ?? DEFAULT_REGION
    yield* images.remove(region, imageId)
    yield* out.print(`Deregistered ${imageId}.`)
  }),
)
