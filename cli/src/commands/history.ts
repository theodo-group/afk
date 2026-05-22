import { Command, Options } from "@effect/cli"
import { Effect } from "effect"
import { HistoryService } from "../services/HistoryService.ts"
import { Sts } from "../adapters/aws/Sts.ts"
import { ConfigService } from "../services/ConfigService.ts"
import { Output } from "../infra/Output.ts"
import { UserError } from "../infra/Errors.ts"
import { DEFAULT_REGION } from "../constants.ts"
import { estimateCost, formatUsd } from "../services/Pricing.ts"

const all = Options.boolean("all").pipe(
  Options.withDescription("show Runs across all team members (requires broader IAM)"),
)
const since = Options.text("since").pipe(
  Options.withDefault("7d"),
  Options.withDescription("time window: e.g. 1h, 24h, 7d, 30d (default 7d)"),
)
const branch = Options.text("branch").pipe(
  Options.optional,
  Options.withDescription("filter to a single branch"),
)

const limit = Options.integer("limit").pipe(
  Options.optional,
  Options.withDescription("cap on rows returned"),
)

const parseSince = (s: string): string => {
  const m = /^(\d+)([smhd])$/.exec(s.trim())
  if (!m) {
    throw new UserError({
      message: `Invalid --since: '${s}'.`,
      hint: "Use a duration like 24h, 7d, 30d.",
    })
  }
  const n = Number(m[1]!)
  const unit = m[2]!
  const ms =
    unit === "s"
      ? n * 1000
      : unit === "m"
        ? n * 60_000
        : unit === "h"
          ? n * 3_600_000
          : n * 86_400_000
  return new Date(Date.now() - ms).toISOString()
}

const formatDuration = (startIso: string, stopIso?: string): string => {
  const start = Date.parse(startIso)
  const stop = stopIso ? Date.parse(stopIso) : Date.now()
  if (!Number.isFinite(start) || !Number.isFinite(stop)) return "-"
  const secs = Math.max(0, Math.floor((stop - start) / 1000))
  if (secs < 60) return `${secs}s`
  if (secs < 3600) return `${Math.floor(secs / 60)}m${secs % 60}s`
  const hours = Math.floor(secs / 3600)
  const mins = Math.floor((secs % 3600) / 60)
  return `${hours}h${mins}m`
}

export const history = Command.make(
  "history",
  { all, since, branch, limit },
  ({ all, since, branch, limit }) =>
    Effect.gen(function* () {
      const hist = yield* HistoryService
      const sts = yield* Sts
      const cfg = yield* ConfigService
      const out = yield* Output
      const { config } = yield* cfg.load
      const region = config.aws?.region ?? DEFAULT_REGION

      const sinceIso = yield* Effect.try({
        try: () => parseSince(since),
        catch: (e) =>
          e instanceof UserError
            ? e
            : new UserError({ message: `--since: ${String(e)}` }),
      })
      const owner = all ? undefined : (yield* sts.callerIdentity).UserId

      const rows = yield* hist.query({
        owner,
        sinceIsoUtc: sinceIso,
        ...(limit._tag === "Some" ? { limit: limit.value } : {}),
      })

      const filtered = rows.filter((r) =>
        branch._tag === "Some" ? r.branch === branch.value : true,
      )

      yield* out.emit({
        data: filtered,
        human: () =>
          filtered.length === 0
            ? out.print("(no Runs matched)")
            : out.printTable(filtered, [
                { header: "RUN ID", value: (r) => r.runId },
                { header: "STATUS", value: (r) => r.status },
                { header: "BRANCH", value: (r) => r.branch },
                { header: "SHA", value: (r) => r.sha.slice(0, 12) },
                {
                  header: "TYPE",
                  value: (r) => `${r.instanceType}${r.spot ? "/spot" : ""}`,
                },
                { header: "STARTED", value: (r) => r.startedAt },
                {
                  header: "DURATION",
                  value: (r) => formatDuration(r.startedAt, r.stoppedAt),
                },
                {
                  header: "EXIT",
                  value: (r) => (r.exitCode === undefined ? "-" : String(r.exitCode)),
                },
                {
                  header: "COST",
                  value: (r) => {
                    const c = estimateCost(
                      region,
                      r.instanceType,
                      r.spot,
                      r.startedAt,
                      r.stoppedAt,
                    )
                    return c ? formatUsd(c.usd) : "-"
                  },
                },
                ...(all
                  ? [{ header: "OWNER", value: (r: typeof filtered[number]) => r.owner }]
                  : []),
              ]),
      })
    }),
)
