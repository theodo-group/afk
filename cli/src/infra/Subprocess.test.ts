import { describe, it, expect } from "bun:test"
import { join } from "node:path"

/**
 * `runInteractive` hands the child our own stdio, so where its stdout lands can
 * only be observed from outside the process. Each case therefore runs a tiny
 * program in a child of its own and reads back the two streams.
 */
const child = (mode: "table" | "json") => `
import { Effect } from "effect"
import { Subprocess, makeSubprocessLive } from "${join(import.meta.dir, "Subprocess.ts")}"

const program = Effect.gen(function* () {
  const sub = yield* Subprocess
  yield* sub.runInteractive("echo", ["the push refers to repository"])
})

await Effect.runPromise(program.pipe(Effect.provide(makeSubprocessLive("${mode}"))))
process.stdout.write('{"runId":"abc"}')
`

const runChild = async (mode: "table" | "json") => {
  const proc = Bun.spawn(["bun", "-e", child(mode)], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  return { stdout, stderr }
}

describe("makeSubprocessLive", () => {
  it("keeps an interactive child's chatter off stdout in json mode", async () => {
    const { stdout, stderr } = await runChild("json")

    expect(stderr).toContain("the push refers to repository")
    expect(stdout).not.toContain("the push refers to repository")
    // The whole point: what remains on stdout still parses.
    expect(JSON.parse(stdout)).toEqual({ runId: "abc" })
  })

  it("leaves the child on the terminal it was given in table mode", async () => {
    const { stdout, stderr } = await runChild("table")

    expect(stdout).toContain("the push refers to repository")
    expect(stderr).not.toContain("the push refers to repository")
  })
})
