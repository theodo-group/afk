import { parseDocument, stringify, YAMLMap, YAMLSeq, Scalar } from "yaml"
import { UserError } from "../infra/Errors.ts"
import { AFK_IMAGE_PLACEHOLDER } from "../constants.ts"

/**
 * YAML-backed lint + (optionally) mutate of the developer's afk.compose.yml.
 *
 * Rules common to every Backend:
 *   - At least one service is declared.
 *   - The named main service exists.
 *   - The main service uses `image: ${AFK_IMAGE}`.
 *   - The main service does NOT declare a long-lived restart policy.
 *   - The main service declares `env_file` and `command: ${AFK_COMMAND}`.
 *
 * Backend-specific behavior:
 *   - "aws": no mutation, lint only.
 *   - "cloudflare": every service is rewritten to `network_mode: host` and
 *     every other service's name is added to its `extra_hosts` mapping to
 *     127.0.0.1. Port collisions across services are a hard error (since CF
 *     Containers spawn on a single host network all ports share the same
 *     namespace).
 */
export interface ComposeLintInput {
  readonly content: string
  readonly mainService: string
  /**
   * "local" reuses the "cloudflare" mutation: it runs the workload inside
   * rootless `dind`, so it needs the same `network_mode: host` + `extra_hosts`
   * addenda and the same port-collision hard error.
   */
  readonly backend: "aws" | "cloudflare" | "local" | "gcp"
}

export interface ComposeLintResult {
  readonly warnings: ReadonlyArray<string>
  /** Possibly-mutated YAML content. For "aws" this equals `input.content`. */
  readonly content: string
}

const asMap = (node: unknown): YAMLMap | null =>
  node instanceof YAMLMap ? node : null

const extractServicePorts = (svc: YAMLMap): string[] => {
  const ports = svc.get("ports")
  if (!(ports instanceof YAMLSeq)) return []
  const out: string[] = []
  for (const item of ports.items) {
    let raw: string | null = null
    if (item instanceof Scalar && typeof item.value === "string") {
      raw = item.value
    } else if (typeof item === "string") {
      raw = item
    } else if (item instanceof YAMLMap) {
      const pub = item.get("published")
      if (typeof pub === "number" || typeof pub === "string") {
        raw = String(pub)
      }
    }
    if (!raw) continue
    // "HOST:CONTAINER" or "HOST:CONTAINER/proto" or just "PORT"
    const hostPart = raw.split(":").length > 1 ? raw.split(":")[0]! : raw
    const cleaned = hostPart.split("/")[0]!.trim()
    if (cleaned) out.push(cleaned)
  }
  return out
}

export const lintCompose = (input: ComposeLintInput): ComposeLintResult => {
  const doc = (() => {
    try {
      return parseDocument(input.content)
    } catch (e) {
      throw new UserError({
        message: `afk.compose.yml: invalid YAML — ${String(e)}`,
      })
    }
  })()
  if (doc.errors.length > 0) {
    throw new UserError({
      message: `afk.compose.yml: invalid YAML — ${doc.errors[0]!.message}`,
    })
  }

  const root = asMap(doc.contents)
  if (!root) {
    throw new UserError({
      message: "afk.compose.yml: top-level must be a mapping.",
    })
  }
  const services = asMap(root.get("services"))
  if (!services || services.items.length === 0) {
    throw new UserError({
      message: "afk.compose.yml declares no services.",
      hint: "Add at least the main service.",
    })
  }

  const serviceNames: string[] = []
  for (const pair of services.items) {
    const key = pair.key as Scalar
    if (key && typeof key.value === "string") serviceNames.push(key.value)
  }

  const main = asMap(services.get(input.mainService))
  if (!main) {
    throw new UserError({
      message: `afk.compose.yml has no '${input.mainService}' service.`,
      hint: `The main service is named by 'mainService' in afk.config.json (default: agent). Either add a '${input.mainService}:' service or change 'mainService'.`,
    })
  }

  const mainImage = main.get("image")
  const mainImageStr = mainImage instanceof Scalar ? mainImage.value : mainImage
  if (
    typeof mainImageStr !== "string" ||
    !mainImageStr.includes(AFK_IMAGE_PLACEHOLDER)
  ) {
    throw new UserError({
      message: `Main service '${input.mainService}' must use 'image: ${AFK_IMAGE_PLACEHOLDER}'.`,
      hint: "The CLI substitutes this with the registry URI of the wrapped agent image at submit time.",
    })
  }

  const restart = main.get("restart")
  const restartStr = restart instanceof Scalar ? restart.value : restart
  if (
    typeof restartStr === "string" &&
    (restartStr === "always" || restartStr === "unless-stopped")
  ) {
    throw new UserError({
      message: `Main service '${input.mainService}' must not use 'restart: always' or 'restart: unless-stopped'.`,
      hint: "Those policies fight AFK's Run-ends-on-exit semantics.",
    })
  }

  if (!main.has("env_file")) {
    throw new UserError({
      message: `main service '${input.mainService}' does not declare 'env_file:'.`,
      hint: `Add: env_file: ["\${AFK_ENV_FILE}"] — without it the container will not see .afk.env values or AFK_GIT_*/GITHUB_TOKEN, and the entrypoint will fail.`,
    })
  }
  const command = main.get("command")
  const commandStr = command instanceof Scalar ? command.value : command
  if (
    typeof commandStr !== "string" ||
    !commandStr.includes("${AFK_COMMAND}")
  ) {
    throw new UserError({
      message: `main service '${input.mainService}' does not declare 'command: \${AFK_COMMAND}'.`,
      hint: `Add: command: \${AFK_COMMAND} — otherwise the args you pass to 'afk run' are silently ignored in favour of any static command:, or the container runs with no command at all.`,
    })
  }

  const warnings: string[] = []

  if (input.backend === "aws" || input.backend === "gcp") {
    // AWS/GCP: real VM host Docker daemon, full Compose Contract. Just warn on
    // `ports:` (the firewall denies inbound anyway).
    for (const name of serviceNames) {
      const svc = asMap(services.get(name))
      if (!svc) continue
      if (svc.has("ports")) {
        warnings.push(
          `service '${name}' declares 'ports:' — inbound is denied at the security-group level, so port mappings have no effect.`,
        )
      }
    }
    return { warnings, content: input.content }
  }

  // ---- Cloudflare backend mutation ----
  //
  // CF Containers run inside a single Worker process; sidecar services
  // therefore share a network namespace. We:
  //  1. Hard-error on duplicate published ports across services.
  //  2. Set `network_mode: host` on every service.
  //  3. Inject `extra_hosts` mapping every OTHER service name → 127.0.0.1
  //     so service-name DNS still resolves to localhost.
  const portOwners = new Map<string, string>()
  for (const name of serviceNames) {
    const svc = asMap(services.get(name))
    if (!svc) continue
    for (const p of extractServicePorts(svc)) {
      const prev = portOwners.get(p)
      if (prev && prev !== name) {
        throw new UserError({
          message: `afk.compose.yml: port ${p} is published by both '${prev}' and '${name}'.`,
          hint: "On the Cloudflare backend, every service shares a network namespace. Choose distinct host ports.",
        })
      }
      portOwners.set(p, name)
    }
  }

  for (const name of serviceNames) {
    const svc = asMap(services.get(name))
    if (!svc) continue
    svc.set("network_mode", "host")
    const others = serviceNames.filter((n) => n !== name)
    if (others.length > 0) {
      const hosts = new YAMLSeq()
      for (const o of others) hosts.add(`${o}:127.0.0.1`)
      svc.set("extra_hosts", hosts)
    }
  }

  return { warnings, content: stringify(doc) }
}

/**
 * Substitute ${AFK_IMAGE} with the supplied image URI. Performed by the CLI
 * client-side so the compose file shipped in user_data already references the
 * resolved registry image; ${AFK_COMMAND} is left intact for shell-side
 * substitution in user_data.
 */
export const substituteImage = (
  composeContent: string,
  imageUri: string,
): string => composeContent.split(AFK_IMAGE_PLACEHOLDER).join(imageUri)

export interface AwsLoggingInput {
  readonly runId: string
  readonly region: string
  readonly logGroup: string
}

/**
 * Pin each service's awslogs stream to `<runId>/<service>` on the AWS Backend.
 * Without this the daemon default streams to `<runId>/{{.Name}}` — the compose
 * *container* name (`<project>-<service>-N`), which the CLI's `<runId>/<service>`
 * stream filter never matches. Mirrors the no-compose path's explicit stream.
 */
export const injectAwsLogging = (
  composeContent: string,
  input: AwsLoggingInput,
): string => {
  const doc = parseDocument(composeContent)
  const services = asMap(asMap(doc.contents)?.get("services"))
  if (!services) return composeContent

  for (const pair of services.items) {
    const key = pair.key as Scalar
    if (!key || typeof key.value !== "string") continue
    const svc = asMap(services.get(key.value))
    if (!svc) continue
    const options = new YAMLMap()
    options.set("awslogs-region", input.region)
    options.set("awslogs-group", input.logGroup)
    options.set("awslogs-create-group", "true")
    options.set("awslogs-stream", `${input.runId}/${key.value}`)
    const logging = new YAMLMap()
    logging.set("driver", "awslogs")
    logging.set("options", options)
    svc.set("logging", logging)
  }
  return stringify(doc)
}

export interface GcpLoggingInput {
  readonly runId: string
  readonly service: string
}

/**
 * Pin each service's logs to the `gcplogs` driver, labelled with the Run id and
 * the compose service name, so `afk logs` can filter Cloud Logging by
 * `labels.afk-run`/`labels.afk-service` per service — the GCP analogue of
 * {@link injectAwsLogging}'s `<runId>/<service>` stream. The VM's instance
 * service account holds `roles/logging.logWriter`, so no credentials are
 * threaded through the driver options.
 */
export const injectGcpLogging = (
  composeContent: string,
  runId: string,
): string => {
  const doc = parseDocument(composeContent)
  const services = asMap(asMap(doc.contents)?.get("services"))
  if (!services) return composeContent

  for (const pair of services.items) {
    const key = pair.key as Scalar
    if (!key || typeof key.value !== "string") continue
    const svc = asMap(services.get(key.value))
    if (!svc) continue
    const options = new YAMLMap()
    options.set("labels", "afk-run,afk-service")
    const logging = new YAMLMap()
    logging.set("driver", "gcplogs")
    logging.set("options", options)
    svc.set("logging", logging)
    // Docker's gcplogs driver reads label *values* off the container, so each
    // service must carry the labels named in `labels:` above.
    const labels = asMap(svc.get("labels")) ?? new YAMLMap()
    labels.set("afk-run", runId)
    labels.set("afk-service", key.value)
    svc.set("labels", labels)
  }
  return stringify(doc)
}
