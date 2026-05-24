import { Command } from "@effect/cli"
import { Effect } from "effect"
import { GoldenImageStore } from "../../services/backend/GoldenImage.ts"
import { Output } from "../../infra/Output.ts"

export const goldenLs = Command.make("ls", {}, () =>
  Effect.gen(function* () {
    const golden = yield* GoldenImageStore
    const out = yield* Output
    const list = yield* golden.list
    yield* out.emit({
      data: list,
      human: () =>
        list.length === 0
          ? out.print("(no Golden Images found — run `afk golden build`)")
          : out.printTable(list, [
              { header: "ID", value: (g) => g.id },
              { header: "READY", value: (g) => (g.ready ? "yes" : "no") },
              { header: "BUILT", value: (g) => g.builtAt || "-" },
              {
                header: "CACHED IMAGES",
                value: (g) =>
                  g.cachedImages.length === 0 ? "-" : g.cachedImages.join(","),
              },
            ]),
    })
  }),
)
