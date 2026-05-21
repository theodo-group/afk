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
            `project root      ${resolved.projectRoot}`,
            `source repo       ${resolved.sourceRepoName}`,
            `git url           ${resolved.config.gitUrl}`,
            `default cpu       ${resolved.config.defaultCpu ?? "(unset)"}`,
            `default memory    ${resolved.config.defaultMemory ?? "(unset)"}`,
            `default timeout   ${resolved.config.defaultTimeoutHours ?? "(unset)"}h`,
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
