import { Command, Options } from "@effect/cli"
import { Effect } from "effect"
import { RunService } from "../services/RunService.ts"
import { Compute } from "../services/backend/Compute.ts"
import { ConfigService } from "../services/ConfigService.ts"
import { Output } from "../infra/Output.ts"
import { DEFAULT_REGION } from "../constants.ts"
import { estimateCost, formatUsd } from "../services/Pricing.ts"

const all = Options.boolean("all").pipe(
  Options.withDescription("show Runs across all team members"),
)
const status = Options.choice("status", ["running", "stopped", "all"]).pipe(
  Options.withDefault("running"),
)

export const ls = Command.make("ls", { all, status }, ({ all, status }) =>
  Effect.gen(function* () {
    const runs = yield* RunService
    const compute = yield* Compute
    const cfg = yield* ConfigService
    const out = yield* Output

    const { config } = yield* cfg.load
    const region = config.aws?.region ?? DEFAULT_REGION

    const me = yield* compute.callerPrincipal
    const list = all ? yield* runs.listAll : yield* runs.listMine(me.id)

    const filtered = list.filter((r) =>
      status === "all"
        ? true
        : status === "running"
          ? r.status === "RUNNING" || r.status === "PROVISIONING"
          : r.status === "STOPPED" || r.status === "STOPPING",
    )

    yield* out.emit({
      data: filtered,
      human: () =>
        out.printTable(filtered, [
          { header: "RUN ID", value: (r) => r.runId },
          { header: "STATUS", value: (r) => r.status },
          {
            // A retained (STOPPED) Run is still resumable via `afk attach` until
            // this window closes; blank for Runs that aren't retained.
            header: "RETAINED",
            value: (r) => {
              if (!r.retainedUntil) return "-"
              const ms = Date.parse(r.retainedUntil) - Date.now()
              if (ms <= 0) return "expiring"
              const days = Math.ceil(ms / 86_400_000)
              return `~${days}d`
            },
          },
          { header: "BRANCH", value: (r) => r.branch },
          { header: "SHA", value: (r) => r.sha.slice(0, 12) },
          {
            header: "TYPE",
            value: (r) => {
              const t =
                r.backendDetails?.instanceType ??
                r.backendDetails?.instanceTier ??
                "-"
              const spot = r.backendDetails?.spot === "true"
              return `${t}${spot ? "/spot" : ""}`
            },
          },
          { header: "OWNER", value: (r) => r.owner },
          { header: "STARTED", value: (r) => r.startedAt ?? "-" },
          {
            header: "COST",
            value: (r) => {
              if (!r.startedAt) return "-"
              if (r.backend !== "aws") return "-"
              const instanceType = r.backendDetails?.instanceType ?? ""
              const spot = r.backendDetails?.spot === "true"
              const c = estimateCost(
                region,
                instanceType,
                spot,
                r.startedAt,
                r.stoppedAt,
              )
              return c ? formatUsd(c.usd) : "-"
            },
          },
        ]),
    })
  }),
)
