import { Command, Options } from "@effect/cli"
import { Effect } from "effect"
import { ImageService } from "../../services/ImageService.ts"
import { CloudflareGoldenBuilder } from "../../services/CloudflareGoldenBuilder.ts"
import { ConfigService } from "../../services/ConfigService.ts"
import { Output } from "../../infra/Output.ts"
import { UserError } from "../../infra/Errors.ts"

const local = Options.boolean("local").pipe(
  Options.withDescription("refuse — the Golden Image is a cloud-only concept"),
)

export const goldenBuild = Command.make("build", { local }, ({ local }) =>
  Effect.gen(function* () {
    if (local) {
      return yield* Effect.fail(
        new UserError({
          message: "`afk golden build --local` is not supported.",
          hint: "The Golden Image is a cloud concept; your local Docker daemon already caches what it pulls.",
        }),
      )
    }
    const cfg = yield* ConfigService
    const out = yield* Output
    const { config } = yield* cfg.load
    const backend = config.backend ?? "aws"

    if (backend === "cloudflare") {
      const builder = yield* CloudflareGoldenBuilder
      yield* out.print("Building Cloudflare Golden Image…")
      const built = yield* builder.build
      yield* out.emit({
        data: built,
        human: () =>
          out.print(
            [
              `Cloudflare Golden Image pushed: ${built.imageUri}`,
              `  tag       ${built.tag}`,
              `  built-at  ${built.builtAt}`,
              `  cached    ${built.cachedImages.length === 0 ? "(none)" : built.cachedImages.join(", ")}`,
            ].join("\n"),
          ),
      })
      return
    }

    const images = yield* ImageService
    yield* out.print("Building Golden Image… this typically takes 5–10 minutes.")
    const built = yield* images.build
    yield* out.emit({
      data: built,
      human: () =>
        out.print(
          [
            `Golden Image built: ${built.imageId}`,
            `  name      ${built.name}`,
            `  built-at  ${built.builtAt}`,
            `  cached    ${built.cachedImages.length === 0 ? "(none)" : built.cachedImages.join(", ")}`,
          ].join("\n"),
        ),
    })
  }),
)
