import { Args, Command } from "@effect/cli"
import { readFileSync } from "node:fs"
import { Effect } from "effect"
import { SecretStore } from "../../services/backend/SecretStore.ts"
import { Output } from "../../infra/Output.ts"
import { UserError } from "../../infra/Errors.ts"

const name = Args.text({ name: "name" }).pipe(
  Args.withDescription(
    "Secret name. Referenced from .afk.env as `secret:<name>`.",
  ),
)
const value = Args.text({ name: "value" }).pipe(
  Args.optional,
  Args.withDescription(
    "Secret value. Visible in `ps` when passed inline — prefer stdin for real secrets. " +
      "Omit to either read from a pipe (e.g. `gcloud secrets versions access latest --secret=GH | afk secrets put github-token`) " +
      "or be prompted interactively (input hidden).",
  ),
)

/**
 * Read one line from the terminal without echoing it. Raw mode turns the echo
 * off; a line read through `console` (the previous approach) printed the secret
 * as it was typed despite the "input hidden" prompt.
 */
const readHidden = (prompt: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const stdin = process.stdin
    process.stderr.write(prompt)
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding("utf8")
    let typed = ""
    const done = (finish: () => void) => {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.off("data", onData)
      process.stderr.write("\n")
      finish()
    }
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          return done(() => resolve(typed))
        }
        if (ch === "\u0003") {
          return done(() => reject(new UserError({ message: "aborted" })))
        }
        if (ch === "\u007f" || ch === "\b") typed = typed.slice(0, -1)
        else typed += ch
      }
    }
    stdin.on("data", onData)
  })

export const put = Command.make("put", { name, value }, ({ name, value }) =>
  Effect.gen(function* () {
    const secrets = yield* SecretStore
    const out = yield* Output

    let plain: string
    if (value._tag === "Some") {
      plain = value.value
    } else {
      const read = yield* Effect.tryPromise({
        try: () =>
          process.stdin.isTTY
            ? readHidden("Value (input hidden): ")
            : Promise.resolve(readFileSync(0, "utf8")),
        catch: (e) =>
          e instanceof UserError
            ? e
            : new UserError({ message: "could not read value from stdin" }),
      })
      plain = read.trim()
    }
    if (!plain) {
      return yield* Effect.fail(
        new UserError({ message: "value must not be empty" }),
      )
    }
    yield* secrets.put(name, plain)
    yield* out.emit({
      data: { name, stored: true },
      human: () => out.print(`stored secret '${name}'`),
    })
  }),
)
