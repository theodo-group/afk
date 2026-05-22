import { UserError } from "../infra/Errors.ts"
import { AFK_IMAGE_PLACEHOLDER } from "../constants.ts"

/**
 * Lightweight, regex-based validation of the dev's afk.compose.yml.
 *
 * We deliberately avoid a full YAML parse here — the lints are about catching
 * the few constructs that conflict with AFK semantics (restart policies on the
 * main service, missing ${AFK_IMAGE} on the main service, exposed ports). A
 * future revision may swap to a proper YAML parser.
 */
export interface ComposeLintInput {
  readonly content: string
  readonly mainService: string
}

export const lintCompose = (
  input: ComposeLintInput,
): { warnings: ReadonlyArray<string> } => {
  const warnings: string[] = []
  const lines = input.content.split("\n")

  // Find each top-level service block by indentation.
  // Compose top-level: `services:` with two-space-indented service names.
  let inServices = false
  let servicesIndent = 0
  let currentService: string | null = null
  let currentServiceIndent = 0
  const serviceBlocks = new Map<string, string[]>()

  for (const raw of lines) {
    const line = raw.replace(/\r$/, "")
    const trimmed = line.trim()
    const indent = line.match(/^ */)?.[0].length ?? 0

    if (!inServices) {
      if (/^services\s*:/.test(trimmed)) {
        inServices = true
        servicesIndent = indent
      }
      continue
    }
    if (trimmed === "" || trimmed.startsWith("#")) continue
    // Left the services block?
    if (indent <= servicesIndent && !/^services\s*:/.test(trimmed)) {
      inServices = false
      currentService = null
      continue
    }
    // A service header looks like `  myservice:` at services+2 indent.
    const headerMatch = /^([A-Za-z0-9_.-]+)\s*:\s*$/.exec(trimmed)
    if (headerMatch && (currentService === null || indent <= currentServiceIndent)) {
      currentService = headerMatch[1]!
      currentServiceIndent = indent
      serviceBlocks.set(currentService, [])
      continue
    }
    if (currentService) {
      serviceBlocks.get(currentService)!.push(line)
    }
  }

  if (serviceBlocks.size === 0) {
    throw new UserError({
      message: "afk.compose.yml declares no services.",
      hint: "Add at least the main service.",
    })
  }

  const mainBlock = serviceBlocks.get(input.mainService)
  if (!mainBlock) {
    throw new UserError({
      message: `afk.compose.yml has no '${input.mainService}' service.`,
      hint: `The main service is named by 'mainService' in afk.config.json (default: agent). Either add a '${input.mainService}:' service or change 'mainService'.`,
    })
  }

  const mainText = mainBlock.join("\n")
  if (!mainText.includes(AFK_IMAGE_PLACEHOLDER)) {
    throw new UserError({
      message: `Main service '${input.mainService}' must use 'image: ${AFK_IMAGE_PLACEHOLDER}'.`,
      hint: "The CLI substitutes this with the ECR URI of the wrapped agent image at submit time.",
    })
  }
  if (/restart:\s*(always|unless-stopped)/.test(mainText)) {
    throw new UserError({
      message: `Main service '${input.mainService}' must not use 'restart: always' or 'restart: unless-stopped'.`,
      hint: "Those policies fight AFK's Run-ends-on-exit semantics.",
    })
  }

  if (!/env_file\s*:/.test(mainText)) {
    throw new UserError({
      message: `main service '${input.mainService}' does not declare 'env_file:'.`,
      hint: `Add: env_file: ["\${AFK_ENV_FILE}"] — without it the container will not see .afk.env values or AFK_GIT_*/GITHUB_TOKEN, and the entrypoint will fail.`,
    })
  }
  if (!/command\s*:\s*\$\{AFK_COMMAND\}/.test(mainText)) {
    throw new UserError({
      message: `main service '${input.mainService}' does not declare 'command: \${AFK_COMMAND}'.`,
      hint: `Add: command: \${AFK_COMMAND} — otherwise the args you pass to 'afk run' are silently ignored in favour of any static command:, or the container runs with no command at all.`,
    })
  }

  for (const [name, block] of serviceBlocks) {
    const text = block.join("\n")
    if (/^\s*ports\s*:/m.test(text)) {
      warnings.push(
        `service '${name}' declares 'ports:' — inbound is denied at the security-group level, so port mappings have no effect.`,
      )
    }
  }

  return { warnings }
}

/**
 * Substitute ${AFK_IMAGE} with the supplied image URI. Performed by the CLI
 * client-side so the compose file shipped in user_data already references the
 * resolved ECR image; ${AFK_COMMAND} is left intact for shell-side substitution
 * in user_data.
 */
export const substituteImage = (composeContent: string, imageUri: string): string =>
  composeContent.split(AFK_IMAGE_PLACEHOLDER).join(imageUri)
