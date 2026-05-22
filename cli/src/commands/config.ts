import { Command } from "@effect/cli"
import { Effect } from "effect"
import { ConfigService } from "../services/ConfigService.ts"
import { Output } from "../infra/Output.ts"

export const config = Command.make("config", {}, () =>
  Effect.gen(function* () {
    const cfg = yield* ConfigService
    const out = yield* Output
    const resolved = yield* cfg.load
    yield* out.emit({
      data: resolved,
      human: () =>
        out.print(
          [
            `project root        ${resolved.projectRoot}`,
            `source repo         ${resolved.sourceRepoName}`,
            `backend             ${resolved.config.backend ?? "aws"}`,
            `git url             ${resolved.config.gitUrl}`,
            `region              ${resolved.config.aws?.region ?? "(unset)"}`,
            `main service        ${resolved.config.mainService ?? "agent"}`,
            `default instance    ${resolved.config.defaultInstanceType ?? "(unset)"}`,
            `allowed instances   ${
              (resolved.config.allowedInstanceTypes ?? []).join(", ") || "(unrestricted)"
            }`,
            `default timeout     ${resolved.config.defaultTimeoutHours ?? "(unset)"}h`,
            `cached images       ${
              (resolved.config.golden?.cachedImages ?? []).join(", ") || "(none)"
            }`,
            `env entries:`,
            ...resolved.envEntries.map((e) =>
              e.kind === "plain"
                ? `  ${e.name} = ${e.value}`
                : `  ${e.name} -> ssm:${e.ssmName}`,
            ),
          ].join("\n"),
        ),
    })
  }),
)
