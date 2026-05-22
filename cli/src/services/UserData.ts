import {
  LOG_GROUP_PREFIX,
  VM_AFK_DIR,
  VM_COMPOSE_PATH,
} from "../constants.ts"

export interface UserDataInput {
  readonly runId: string
  readonly region: string
  readonly accountId: string
  readonly repoName: string
  readonly mainService: string
  readonly image: string
  readonly command: ReadonlyArray<string>
  readonly timeoutSeconds: number
  /** Plain environment variables to pass to the container(s). */
  readonly env: ReadonlyArray<{ readonly name: string; readonly value: string }>
  /** SSM Parameter Store references to dereference at boot. */
  readonly secrets: ReadonlyArray<{ readonly name: string; readonly ssmName: string }>
  /**
   * Compose file content as authored by the developer. Undefined for no-compose Runs.
   * The CLI has already substituted ${AFK_IMAGE}; ${AFK_COMMAND} is interpolated at boot.
   */
  readonly compose?: string
}

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

const renderEnvFileWrites = (
  env: ReadonlyArray<{ name: string; value: string }>,
): string => {
  if (env.length === 0) return "# (no plain env vars)"
  return env
    .map(
      (e) =>
        `printf '%s=%s\\n' ${shellQuote(e.name)} ${shellQuote(e.value)} >> "$AFK_ENV_FILE"`,
    )
    .join("\n")
}

const renderSecretFetches = (
  secrets: ReadonlyArray<{ name: string; ssmName: string }>,
  region: string,
): string => {
  if (secrets.length === 0) return "# (no ssm secrets)"
  return secrets
    .map((s) => {
      const param = s.ssmName.startsWith("/") ? s.ssmName : `/${s.ssmName}`
      return [
        `_val=$(aws --region ${shellQuote(region)} ssm get-parameter --with-decryption --name ${shellQuote(param)} --query Parameter.Value --output text)`,
        `printf '%s=%s\\n' ${shellQuote(s.name)} "$_val" >> "$AFK_ENV_FILE"`,
        `unset _val`,
      ].join("\n")
    })
    .join("\n")
}

const renderDaemonJson = (logGroup: string, region: string, runId: string): string =>
  JSON.stringify(
    {
      "log-driver": "awslogs",
      "log-opts": {
        "awslogs-region": region,
        "awslogs-group": logGroup,
        "awslogs-create-group": "true",
        "awslogs-stream": `${runId}/{{.Name}}`,
      },
    },
    null,
    2,
  )

/**
 * Render the developer's command as a shell-quoted string suitable for
 * `${AFK_COMMAND}` interpolation. Joins with spaces — the in-container
 * entrypoint runs it via `sh -c "$AFK_COMMAND"` for the no-compose path and
 * via compose's own command interpolation for the compose path.
 */
const renderCommandShellString = (command: ReadonlyArray<string>): string =>
  command.length === 0 ? "" : command.join(" ")

export const buildUserData = (input: UserDataInput): string => {
  const logGroup = `${LOG_GROUP_PREFIX}/${input.repoName}`
  const daemonJson = renderDaemonJson(logGroup, input.region, input.runId)
  const cmdShell = renderCommandShellString(input.command)

  // The compose file the dev wrote (with ${AFK_IMAGE} already substituted by
  // the CLI). ${AFK_COMMAND} is left intact — compose substitutes it at runtime
  // from the shell env we set just before `docker compose up`.
  const composeBlock = input.compose
    ? [
        `cat > ${shellQuote(VM_COMPOSE_PATH)} <<'AFK_COMPOSE_EOF'`,
        input.compose,
        `AFK_COMPOSE_EOF`,
      ].join("\n")
    : ""

  const runWorkload = input.compose
    ? [
        // export env-file vars + AFK_COMMAND so compose interpolation picks them up.
        `export AFK_COMMAND=${shellQuote(cmdShell)}`,
        `set -a; . "$AFK_ENV_FILE"; set +a`,
        `cd ${shellQuote(VM_AFK_DIR)}`,
        `timeout --preserve-status ${input.timeoutSeconds}s docker compose -f ${shellQuote(VM_COMPOSE_PATH)} \\`,
        `  up --exit-code-from ${shellQuote(input.mainService)} --abort-on-container-exit`,
        `RUN_EXIT=$?`,
        `docker compose -f ${shellQuote(VM_COMPOSE_PATH)} down -v --remove-orphans || true`,
      ].join("\n")
    : [
        `timeout --preserve-status ${input.timeoutSeconds}s docker run --rm \\`,
        `  --name agent \\`,
        `  --env-file "$AFK_ENV_FILE" \\`,
        `  --log-driver awslogs \\`,
        `  --log-opt awslogs-region=${input.region} \\`,
        `  --log-opt awslogs-group=${shellQuote(logGroup)} \\`,
        `  --log-opt awslogs-stream=${shellQuote(`${input.runId}/agent`)} \\`,
        `  --log-opt awslogs-create-group=true \\`,
        `  ${shellQuote(input.image)} \\`,
        `  sh -c ${shellQuote(cmdShell)}`,
        `RUN_EXIT=$?`,
      ].join("\n")

  return [
    "#!/bin/bash",
    "set -uo pipefail",
    "exec > >(tee /var/log/afk-userdata.log | logger -t afk-userdata -s 2>/dev/console) 2>&1",
    `echo "afk-userdata: start run ${input.runId}"`,
    "",
    "# --- Docker daemon config (awslogs driver as default) ---",
    `mkdir -p /etc/docker ${shellQuote(VM_AFK_DIR)}`,
    `cat > /etc/docker/daemon.json <<'AFK_DAEMON_EOF'`,
    daemonJson,
    `AFK_DAEMON_EOF`,
    "systemctl restart docker",
    "",
    "# --- ECR login (instance profile creds) ---",
    `aws --region ${shellQuote(input.region)} ecr get-login-password \\`,
    `  | docker login --username AWS --password-stdin ${input.accountId}.dkr.ecr.${input.region}.amazonaws.com`,
    "",
    "# --- Pull agent image ---",
    `docker pull ${shellQuote(input.image)}`,
    "",
    "# --- Build env file (plain + decrypted secrets) ---",
    `export AFK_ENV_FILE=${shellQuote(`${VM_AFK_DIR}/run.env`)}`,
    `export AFK_IMAGE=${shellQuote(input.image)}`,
    `: > "$AFK_ENV_FILE"`,
    `chmod 600 "$AFK_ENV_FILE"`,
    renderEnvFileWrites(input.env),
    renderSecretFetches(input.secrets, input.region),
    "",
    composeBlock,
    "",
    "# --- Run the workload under wall-clock cap ---",
    "set +e",
    runWorkload,
    "set -e",
    `echo "afk-userdata: run exited $RUN_EXIT"`,
    "",
    "# --- Self-terminate via OS shutdown (instance has terminate-on-shutdown) ---",
    "shutdown -h now",
    "",
  ].join("\n")
}
