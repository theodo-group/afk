import { Command } from "@effect/cli"
import { Effect } from "effect"
import { TeamService } from "../../services/TeamService.ts"
import { Output } from "../../infra/Output.ts"

export const ls = Command.make("ls", {}, () =>
  Effect.gen(function* () {
    const team = yield* TeamService
    const out = yield* Output
    const members = yield* team.ls
    yield* out.emit({
      data: members,
      human: () =>
        out.printTable(members, [
          { header: "NAME", value: (m) => m.name },
          { header: "KIND", value: (m) => m.kind },
          { header: "ARN", value: (m) => m.arn },
          { header: "CREATED", value: (m) => m.createdAt ?? "-" },
        ]),
    })
  }),
)
