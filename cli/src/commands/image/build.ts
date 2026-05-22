import { Command, Options } from "@effect/cli"
import { Effect } from "effect"
import { ImageService } from "../../services/ImageService.ts"
import { Output } from "../../infra/Output.ts"
import { UserError } from "../../infra/Errors.ts"

const local = Options.boolean("local").pipe(
  Options.withDescription("refuse — the golden image is a cloud-only concept"),
)

export const imageBuild = Command.make("build", { local }, ({ local }) =>
  Effect.gen(function* () {
    if (local) {
      return yield* Effect.fail(
        new UserError({
          message: "`afk image build --local` is not supported.",
          hint: "The Golden Image is a cloud concept; your local Docker daemon already caches what it pulls.",
        }),
      )
    }
    const images = yield* ImageService
    const out = yield* Output
    yield* out.print("Building golden AMI… this typically takes 5–10 minutes.")
    const built = yield* images.build
    yield* out.emit({
      data: built,
      human: () =>
        out.print(
          [
            `Golden AMI built: ${built.imageId}`,
            `  name      ${built.name}`,
            `  built-at  ${built.builtAt}`,
            `  cached    ${built.cachedImages.length === 0 ? "(none)" : built.cachedImages.join(", ")}`,
          ].join("\n"),
        ),
    })
  }),
)
