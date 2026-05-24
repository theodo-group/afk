import { Context, Effect, Layer } from "effect"

export type OutputMode = "table" | "json"

export interface Column<T> {
  readonly header: string
  readonly value: (row: T) => string
}

export class Output extends Context.Tag("Output")<
  Output,
  {
    readonly mode: OutputMode
    readonly print: (text: string) => Effect.Effect<void>
    readonly printJson: (value: unknown) => Effect.Effect<void>
    readonly printTable: <T>(
      rows: ReadonlyArray<T>,
      columns: ReadonlyArray<Column<T>>,
    ) => Effect.Effect<void>
    /** json mode ignores the human formatter entirely. */
    readonly emit: <T>(opts: {
      readonly data: T
      readonly human: (data: T) => Effect.Effect<void>
    }) => Effect.Effect<void>
  }
>() {}

const renderTable = <T>(
  rows: ReadonlyArray<T>,
  columns: ReadonlyArray<Column<T>>,
): string => {
  if (rows.length === 0) return ""
  const widths = columns.map((c) =>
    Math.max(c.header.length, ...rows.map((r) => c.value(r).length)),
  )
  const pad = (s: string, w: number) =>
    s + " ".repeat(Math.max(0, w - s.length))
  const headerLine = columns.map((c, i) => pad(c.header, widths[i]!)).join("  ")
  const sep = widths.map((w) => "-".repeat(w)).join("  ")
  const body = rows.map((r) =>
    columns.map((c, i) => pad(c.value(r), widths[i]!)).join("  "),
  )
  return [headerLine, sep, ...body].join("\n")
}

export const makeOutputLive = (mode: OutputMode): Layer.Layer<Output> =>
  Layer.succeed(
    Output,
    Output.of({
      mode,
      print: (text) =>
        Effect.sync(() => {
          console.log(text)
        }),
      printJson: (value) =>
        Effect.sync(() => {
          console.log(JSON.stringify(value, null, 2))
        }),
      printTable: (rows, columns) =>
        Effect.sync(() => {
          const rendered = renderTable(rows, columns)
          if (rendered) console.log(rendered)
        }),
      emit: ({ data, human }) =>
        mode === "json"
          ? Effect.sync(() => console.log(JSON.stringify(data, null, 2)))
          : human(data),
    }),
  )
