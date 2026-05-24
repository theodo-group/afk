import { Command } from "@effect/cli"
import { Effect } from "effect"
import { GoldenImageStore } from "../../services/backend/GoldenImage.ts"
import { Output } from "../../infra/Output.ts"

export const goldenBuild = Command.make("build", {}, () =>
  Effect.gen(function* () {
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
