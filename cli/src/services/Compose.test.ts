import { describe, expect, it } from "bun:test"
import { lintCompose } from "./Compose.ts"

const compose = (main: string) => `services:
  agent:
    image: \${AFK_IMAGE}
    env_file: ["\${AFK_ENV_FILE}"]
${main}
`

const lint = (yaml: string) =>
  lintCompose({ content: yaml, mainService: "agent", backend: "aws" })

describe("the main service must hand the command to the container", () => {
  it("accepts it spliced into command:", () => {
    expect(() => lint(compose('    command: \${AFK_COMMAND}'))).not.toThrow()
  })

  it("accepts it handed over through the environment, for a wrapper to run", () => {
    // A wrapper (setup → command → publication) is better served by an environment value: compose
    // interpolates it verbatim, so a command carrying quotes is not re-quoted on the way in.
    const yaml = compose(
      '    command: ["bash", "-lc", "bash scripts/afk-run.sh"]\n' +
        '    environment:\n      AFK_COMMAND_INNER: "\${AFK_COMMAND}"',
    )
    expect(() => lint(yaml)).not.toThrow()
  })

  it("refuses when the command reaches the container nowhere", () => {
    const yaml = compose('    command: ["bash", "-lc", "bash scripts/afk-run.sh"]')
    expect(() => lint(yaml)).toThrow(/never references/)
  })
})
