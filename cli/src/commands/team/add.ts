import { Args, Command, Options } from "@effect/cli"
import { Effect } from "effect"
import { Team } from "../../services/backend/Team.ts"
import { Output } from "../../infra/Output.ts"

const name = Args.text({ name: "name" })
const principal = Options.text("principal").pipe(
  Options.optional,
  Options.withDescription(
    "ARN of an existing principal to trust on the afk-developer role (default: create a new IAM user)",
  ),
)

export const add = Command.make(
  "add",
  { name, principal },
  ({ name, principal }) =>
    Effect.gen(function* () {
      const team = yield* Team
      const out = yield* Output
      const result = yield* team.add({
        name,
        principal: principal._tag === "Some" ? principal.value : undefined,
      })
      yield* out.emit({
        data: result,
        human: () => {
          const lines: string[] = []
          lines.push(`added ${result.member.kind}: ${result.member.name}`)
          lines.push(`  arn: ${result.member.arn}`)
          if (result.accessKey) {
            lines.push(``)
            lines.push(`Access key (shown ONCE — store securely):`)
            lines.push(`  AWS_ACCESS_KEY_ID=${result.accessKey.accessKeyId}`)
            lines.push(
              `  AWS_SECRET_ACCESS_KEY=${result.accessKey.secretAccessKey}`,
            )
          }
          if (result.serviceToken) {
            lines.push(``)
            lines.push(`Service token (shown ONCE — store securely):`)
            lines.push(`  AFK_CF_CLIENT_ID=${result.serviceToken.clientId}`)
            lines.push(
              `  AFK_CF_CLIENT_SECRET=${result.serviceToken.clientSecret}`,
            )
          }
          return out.print(lines.join("\n"))
        },
      })
    }),
)
