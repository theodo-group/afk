import { Command } from "@effect/cli"
import { Effect } from "effect"
import { Subprocess, checkBinary } from "../infra/Subprocess.ts"
import { Sts } from "../adapters/aws/Sts.ts"
import { Output } from "../infra/Output.ts"
import { UserError } from "../infra/Errors.ts"

interface CheckResult {
  readonly name: string
  readonly ok: boolean
  readonly detail: string
}

export const doctor = Command.make("doctor", {}, () =>
  Effect.gen(function* () {
    const sub = yield* Subprocess
    const out = yield* Output
    const sts = yield* Sts

    const checks: CheckResult[] = []

    for (const bin of ["bun", "docker", "terraform", "aws", "git"]) {
      const has = yield* checkBinary(bin)
      checks.push({
        name: bin,
        ok: has,
        detail: has ? "found" : "not on PATH",
      })
    }

    const ssmPluginPath = yield* sub
      .run("which", ["session-manager-plugin"])
      .pipe(
        Effect.map((r) => r.stdout.trim()),
        Effect.catchAll(() => Effect.succeed("")),
      )
    checks.push({
      name: "session-manager-plugin",
      ok: ssmPluginPath.length > 0,
      detail:
        ssmPluginPath.length > 0
          ? "found"
          : "not on PATH (required for `afk attach`)",
    })

    const identity = yield* sts.callerIdentity.pipe(Effect.either)
    checks.push(
      identity._tag === "Right"
        ? {
            name: "aws credentials",
            ok: true,
            detail: `${identity.right.Arn} (account ${identity.right.Account})`,
          }
        : {
            name: "aws credentials",
            ok: false,
            detail: "could not call sts:GetCallerIdentity",
          },
    )

    yield* out.emit({
      data: { checks, ok: checks.every((c) => c.ok) },
      human: () =>
        out.printTable(checks, [
          { header: "CHECK", value: (c) => c.name },
          { header: "STATUS", value: (c) => (c.ok ? "ok" : "FAIL") },
          { header: "DETAIL", value: (c) => c.detail },
        ]),
    })

    if (checks.some((c) => !c.ok)) {
      return yield* Effect.fail(
        new UserError({
          message: "doctor: one or more checks failed",
        }),
      )
    }
  }),
)
