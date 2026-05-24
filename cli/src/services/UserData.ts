import { LOG_GROUP_PREFIX, VM_AFK_DIR, VM_COMPOSE_PATH } from "../constants.ts"
import { injectAwsLogging } from "./Compose.ts"

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
  readonly secrets: ReadonlyArray<{
    readonly name: string
    readonly ssmName: string
  }>
  /**
   * Compose file content as authored by the developer. Undefined for no-compose Runs.
   * The CLI has already substituted ${AFK_IMAGE}; ${AFK_COMMAND} is interpolated at boot.
   */
  readonly compose?: string
  /**
   * Session Artifact base dirs (longest glob-free prefixes of the declared
   * patterns) to `docker cp` out of the main service at graceful exit. Empty
   * when the dev declared none — collection is skipped entirely.
   */
  readonly sessionArtifactBases: ReadonlyArray<string>
  /** S3 bucket Session Artifacts are uploaded to. */
  readonly sessionArtifactBucket: string
  /** Per-file size cap; matched files larger than this are skipped, not truncated. */
  readonly sessionArtifactMaxBytes: number
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

const renderDaemonJson = (
  logGroup: string,
  region: string,
  runId: string,
): string =>
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

/**
 * Session Artifact collection block (see CONTEXT.md). Best-effort, run after the
 * workload exits but before the VM self-terminates: `docker cp` each declared
 * base dir out of the (just-exited, not-yet-removed) main service container,
 * drop files over the cap, and upload the staged tree to the per-Run S3 prefix.
 * Every step is non-fatal — a failure here never changes the Run's exit status.
 * `containerRefExpr` resolves the main container: its name on the no-compose
 * path, a `compose ps -q` substitution on the compose path. Returns "" when no
 * artifacts are declared, so nothing is emitted and `--rm` stays on the run.
 */
const renderArtifactCollection = (
  containerRefExpr: string,
  input: UserDataInput,
): string => {
  if (input.sessionArtifactBases.length === 0) return ""
  const stage = `${VM_AFK_DIR}/session-artifacts`
  const prefix = `${input.repoName}/${input.runId}/session-artifacts/`
  const bases = input.sessionArtifactBases.map(shellQuote).join(" ")
  return [
    `# --- Collect Session Artifacts (best-effort) ---`,
    `AFK_ART_STAGE=${shellQuote(stage)}`,
    `AFK_CREF=${containerRefExpr}`,
    `if [ -n "$AFK_CREF" ]; then`,
    `  mkdir -p "$AFK_ART_STAGE"`,
    `  for base in ${bases}; do`,
    `    rel=\${base#/}`,
    `    parent="$AFK_ART_STAGE/$(dirname "$rel")"`,
    `    mkdir -p "$parent"`,
    `    docker cp "$AFK_CREF:$base" "$parent/" 2>/dev/null \\`,
    `      && echo "afk-userdata: collected session artifact $base" \\`,
    `      || echo "afk-userdata: no session artifact at $base"`,
    `  done`,
    `  find "$AFK_ART_STAGE" -type f -size +${input.sessionArtifactMaxBytes}c -print -delete 2>/dev/null \\`,
    `    | sed 's#^#afk-userdata: skipped (over cap): #' || true`,
    `  aws s3 cp --recursive "$AFK_ART_STAGE" ${shellQuote(`s3://${input.sessionArtifactBucket}/${prefix}`)} --region ${shellQuote(input.region)} >/dev/null 2>&1 \\`,
    `    && echo "afk-userdata: uploaded session artifacts" \\`,
    `    || echo "afk-userdata: session artifact upload failed (non-fatal)"`,
    `fi`,
  ].join("\n")
}

export const buildUserData = (input: UserDataInput): string => {
  const logGroup = `${LOG_GROUP_PREFIX}/${input.repoName}`
  const daemonJson = renderDaemonJson(logGroup, input.region, input.runId)
  const cmdShell = renderCommandShellString(input.command)
  const collectArtifacts = input.sessionArtifactBases.length > 0

  // The compose file the dev wrote (with ${AFK_IMAGE} already substituted by
  // the CLI). ${AFK_COMMAND} is left intact — compose substitutes it at runtime
  // from the shell env we set just before `docker compose up`. Each service's
  // logs are pinned to the `<runId>/<service>` stream the LogStore filter reads.
  const composeForVm = input.compose
    ? injectAwsLogging(input.compose, {
        runId: input.runId,
        region: input.region,
        logGroup,
      })
    : undefined
  const composeBlock = composeForVm
    ? [
        `cat > ${shellQuote(VM_COMPOSE_PATH)} <<'AFK_COMPOSE_EOF'`,
        composeForVm,
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
        // Collect before `down` removes the (exited) main container.
        renderArtifactCollection(
          `$(docker compose -f ${shellQuote(VM_COMPOSE_PATH)} ps -aq ${shellQuote(input.mainService)})`,
          input,
        ),
        `docker compose -f ${shellQuote(VM_COMPOSE_PATH)} down -v --remove-orphans || true`,
      ]
        .filter((l) => l !== "")
        .join("\n")
    : [
        // `--rm` is dropped when collecting so the exited container survives for
        // `docker cp`; we remove it explicitly after collection.
        `timeout --preserve-status ${input.timeoutSeconds}s docker run ${collectArtifacts ? "" : "--rm "}\\`,
        `  --name ${shellQuote(input.mainService)} \\`,
        `  --env-file "$AFK_ENV_FILE" \\`,
        `  --log-driver awslogs \\`,
        `  --log-opt awslogs-region=${input.region} \\`,
        `  --log-opt awslogs-group=${shellQuote(logGroup)} \\`,
        `  --log-opt awslogs-stream=${shellQuote(`${input.runId}/${input.mainService}`)} \\`,
        `  --log-opt awslogs-create-group=true \\`,
        `  ${shellQuote(input.image)} \\`,
        `  sh -c ${shellQuote(cmdShell)}`,
        `RUN_EXIT=$?`,
        renderArtifactCollection(shellQuote(input.mainService), input),
        collectArtifacts
          ? `docker rm -f ${shellQuote(input.mainService)} >/dev/null 2>&1 || true`
          : "",
      ]
        .filter((l) => l !== "")
        .join("\n")

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
