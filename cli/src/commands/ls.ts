import { Command, Options } from "@effect/cli"
import { Effect } from "effect"
import { RunService } from "../services/RunService.ts"
import { Sts } from "../adapters/aws/Sts.ts"
import { Output } from "../infra/Output.ts"

const all = Options.boolean("all").pipe(
  Options.withDescription("show Runs across all team members"),
)
const status = Options.choice("status", ["running", "stopped", "all"]).pipe(
  Options.withDefault("running"),
)

export const ls = Command.make("ls", { all, status }, ({ all, status }) =>
  Effect.gen(function* () {
    const runs = yield* RunService
    const sts = yield* Sts
    const out = yield* Output

    const list = all
      ? yield* runs.listAll
      : yield* runs.listMine((yield* sts.callerIdentity).Arn)

    const filtered = list.filter((r) =>
      status === "all"
        ? true
        : status === "running"
          ? r.status === "RUNNING" || r.status === "PROVISIONING" || r.status === "PENDING"
          : r.status === "STOPPED",
    )

    yield* out.emit({
      data: filtered,
      human: () =>
        out.printTable(filtered, [
          { header: "RUN ID", value: (r) => r.runId },
          { header: "STATUS", value: (r) => r.status },
          { header: "BRANCH", value: (r) => r.branch },
          { header: "SHA", value: (r) => r.sha.slice(0, 12) },
          { header: "OWNER", value: (r) => r.owner },
          { header: "STARTED", value: (r) => r.startedAt ?? "-" },
        ]),
    })
  }),
)
