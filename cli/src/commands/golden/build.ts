import { Command, Options } from "@effect/cli"
import { Effect } from "effect"
import { GoldenImageStore } from "../../services/backend/GoldenImage.ts"
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
    const golden = yield* GoldenImageStore
    const out = yield* Output
    yield* out.print("Building Golden Image…")
    const built = yield* golden.build
    yield* out.emit({
      data: built,
      human: () =>
        out.print(
          [
            `Golden Image built: ${built.id}`,
            `  name      ${built.displayName}`,
            `  built-at  ${built.builtAt}`,
            `  cached    ${built.cachedImages.length === 0 ? "(none)" : built.cachedImages.join(", ")}`,
            ...(built.note ? [`  note      ${built.note}`] : []),
          ].join("\n"),
        ),
    })
  }),
)
