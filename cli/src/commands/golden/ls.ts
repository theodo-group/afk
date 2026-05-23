import { Command } from "@effect/cli"
import { Effect } from "effect"
import { ImageService } from "../../services/ImageService.ts"
import { CloudflareGoldenBuilder } from "../../services/CloudflareGoldenBuilder.ts"
import { ConfigService } from "../../services/ConfigService.ts"
import { Output } from "../../infra/Output.ts"
import { DEFAULT_REGION } from "../../constants.ts"

export const goldenLs = Command.make("ls", {}, () =>
  Effect.gen(function* () {
    const cfg = yield* ConfigService
    const out = yield* Output
    const { config } = yield* cfg.load
    const backend = config.backend ?? "aws"

    if (backend === "cloudflare") {
      const builder = yield* CloudflareGoldenBuilder
      const list = yield* builder.list
      yield* out.emit({
        data: list,
        human: () =>
          list.length === 0
            ? out.print(
                "(no golden tags found — CF registry listing not yet wired; see CloudflareGoldenBuilder TODO)",
              )
            : out.printTable(list, [
                { header: "TAG", value: (g) => g.tag },
                { header: "BUILT", value: (g) => g.builtAt },
                {
                  header: "CACHED IMAGES",
                  value: (g) =>
                    g.cachedImages.length === 0 ? "-" : g.cachedImages.join(","),
                },
              ]),
      })
      return
    }

    const images = yield* ImageService
    const region = config.aws?.region ?? DEFAULT_REGION
    const list = yield* images.listGolden(region)
    yield* out.emit({
      data: list,
      human: () =>
        list.length === 0
          ? out.print("(no golden AMIs found)")
          : out.printTable(list, [
              { header: "AMI", value: (g) => g.imageId },
              { header: "STATE", value: (g) => g.state },
              { header: "BUILT", value: (g) => g.builtAt },
              {
                header: "CACHED IMAGES",
                value: (g) =>
                  g.cachedImages.length === 0 ? "-" : g.cachedImages.join(","),
              },
            ]),
    })
  }),
)
