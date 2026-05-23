import { Command } from "@effect/cli"
import { Effect } from "effect"
import { ConfigService } from "../services/ConfigService.ts"
import { Output } from "../infra/Output.ts"

export const config = Command.make("config", {}, () =>
  Effect.gen(function* () {
    const cfg = yield* ConfigService
    const out = yield* Output
    const resolved = yield* cfg.load
    const c = resolved.config
    const awsCached =
      c.aws?.cachedImages ?? c.golden?.cachedImages ?? []
    yield* out.emit({
      data: resolved,
      human: () =>
        out.print(
          [
            `project root        ${resolved.projectRoot}`,
            `source repo         ${resolved.sourceRepoName}`,
            `backend             ${c.backend ?? "aws"}`,
            `git url             ${c.gitUrl}`,
            `main service        ${c.mainService ?? "agent"}`,
            `default timeout     ${c.defaultTimeoutHours ?? "(unset)"}h`,
            ``,
            `[aws]`,
            `  region            ${c.aws?.region ?? "(unset)"}`,
            `  default instance  ${c.aws?.defaultInstanceType ?? c.defaultInstanceType ?? "(unset)"}`,
            `  allowed instances ${
              (c.aws?.allowedInstanceTypes ?? c.allowedInstanceTypes ?? []).join(", ") ||
              "(unrestricted)"
            }`,
            `  cached images     ${awsCached.join(", ") || "(none)"}`,
            ``,
            `[cloudflare]`,
            `  account id        ${c.cloudflare?.accountId ?? "(unset)"}`,
            `  worker name       ${c.cloudflare?.workerName ?? "(unset)"}`,
            `  placement         ${c.cloudflare?.placement ?? "(unset)"}`,
            `  default tier      ${c.cloudflare?.defaultInstanceTier ?? "(unset)"}`,
            `  cached images     ${(c.cloudflare?.cachedImages ?? []).join(", ") || "(none)"}`,
            ``,
            `env entries:`,
            ...resolved.envEntries.map((e) =>
              e.kind === "plain"
                ? `  ${e.name} = ${e.value}`
                : `  ${e.name} -> secret:${e.secretName}`,
            ),
          ].join("\n"),
        ),
    })
  }),
)
