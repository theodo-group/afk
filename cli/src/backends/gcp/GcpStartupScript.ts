import {
  GCP_BACKEND_ENV,
  GCP_SECRET_PREFIX,
  VM_AFK_DIR,
  VM_COMPOSE_PATH,
} from "../../constants.ts"

/**
 * Functional core for the GCP Backend's GCE startup-script — the analogue of
 * `services/UserData.ts`'s `buildUserData`. Pure string assembly: the shell
 * (`GcpRunPlan` / `GcpCompute`) injects the resolved values and `GcpCompute`
 * hands the script to `Gce.createInstance` as the `startup-script` metadata.
 *
 * Differences from the AWS user-data:
 *   - Secrets are read with `gcloud secrets versions access` (the instance SA
 *     holds `roles/secretmanager.secretAccessor`), not SSM.
 *   - Logging is the Docker `gcplogs` driver, injected per compose service by
 *     `injectGcpLogging` *before* this runs — so there is no daemon.json here.
 *   - Self-reclaim is `gcloud compute instances delete` (the GCE
 *     `max_run_duration` backstop deletes it regardless). `AFK_BACKEND=gcp` and
 *     `ZONE` are exported so the CLI-owned entrypoint knows which delete to run.
 */
export interface GcpStartupScriptInput {
  readonly runId: string
  readonly project: string
  readonly zone: string
  readonly instanceName: string
  readonly mainService: string
  readonly image: string
  readonly command: ReadonlyArray<string>
  readonly timeoutSeconds: number
  readonly env: ReadonlyArray<{ readonly name: string; readonly value: string }>
  /** Secret Manager secret ids (already prefixed) to read at boot. */
  readonly secrets: ReadonlyArray<string>
  /** Env-var name ↦ canonical secret name mapping for the env file. */
  readonly secretEnvNames: ReadonlyArray<{
    readonly name: string
    readonly secretName: string
  }>
  /** Compose YAML (gcplogs already injected, ${AFK_IMAGE} already substituted). */
  readonly compose?: string
  readonly sessionArtifactBases: ReadonlyArray<string>
  readonly sessionArtifactBucket: string
  readonly sessionArtifactPrefix: string
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
  secrets: ReadonlyArray<{ name: string; secretName: string }>,
  project: string,
): string => {
  if (secrets.length === 0) return "# (no secrets)"
  // Hits the Secret Manager REST API directly with the metadata-server access
  // token; the response payload is base64-encoded, hence the `base64 -d`.
  // Avoids depending on `gcloud` (not on Container-Optimized OS).
  return secrets
    .map((s) => {
      const id = `${GCP_SECRET_PREFIX}-${s.secretName}`
      const url = `https://secretmanager.googleapis.com/v1/projects/${project}/secrets/${id}/versions/latest:access`
      return [
        `AFK_TOKEN=$(afk_token)`,
        `_val=$(curl -fsS -H "Authorization: Bearer $AFK_TOKEN" ${shellQuote(url)} \\`,
        `  | sed -nE 's/.*"data":"([^"]+)".*/\\1/p' | base64 -d)`,
        `printf '%s=%s\\n' ${shellQuote(s.name)} "$_val" >> "$AFK_ENV_FILE"`,
        `unset _val`,
      ].join("\n")
    })
    .join("\n")
}

const renderCommandShellString = (command: ReadonlyArray<string>): string =>
  command.length === 0 ? "" : command.join(" ")

const renderArtifactCollection = (
  containerRefExpr: string,
  input: GcpStartupScriptInput,
): string => {
  if (input.sessionArtifactBases.length === 0) return ""
  const stage = `${VM_AFK_DIR}/session-artifacts`
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
    `      && echo "afk-startup: collected session artifact $base" \\`,
    `      || echo "afk-startup: no session artifact at $base"`,
    `  done`,
    `  find "$AFK_ART_STAGE" -type f -size +${input.sessionArtifactMaxBytes}c -print -delete 2>/dev/null \\`,
    `    | sed 's#^#afk-startup: skipped (over cap): #' || true`,
    `  # GCS upload via REST (no gcloud on COS). One object per file, name`,
    `  # = <prefix>/<relative path>, URL-encoded byte-wise via printf | od.`,
    `  AFK_TOKEN=$(afk_token)`,
    `  AFK_BUCKET=${shellQuote(input.sessionArtifactBucket)}`,
    `  AFK_PREFIX=${shellQuote(input.sessionArtifactPrefix)}`,
    `  while IFS= read -r -d '' _f; do`,
    `    _rel="\${_f#$AFK_ART_STAGE/}"`,
    `    _enc=$(printf '%s' "$AFK_PREFIX/$_rel" \\`,
    `      | od -An -tx1 -v | tr -d ' \\n' | sed -E 's/(..)/%\\1/g')`,
    `    if curl -fsS -X POST -H "Authorization: Bearer $AFK_TOKEN" \\`,
    `        -H "Content-Type: application/octet-stream" --data-binary "@$_f" \\`,
    `        "https://storage.googleapis.com/upload/storage/v1/b/$AFK_BUCKET/o?uploadType=media&name=$_enc" \\`,
    `        >/dev/null; then`,
    `      echo "afk-startup: uploaded session artifact $_rel"`,
    `    else`,
    `      echo "afk-startup: session artifact $_rel upload failed (non-fatal)"`,
    `    fi`,
    `  done < <(find "$AFK_ART_STAGE" -type f -print0 2>/dev/null)`,
    `fi`,
  ].join("\n")
}

export const buildStartupScript = (input: GcpStartupScriptInput): string => {
  const cmdShell = renderCommandShellString(input.command)
  const collectArtifacts = input.sessionArtifactBases.length > 0

  const composeBlock = input.compose
    ? [
        `cat > ${shellQuote(VM_COMPOSE_PATH)} <<'AFK_COMPOSE_EOF'`,
        input.compose,
        `AFK_COMPOSE_EOF`,
      ].join("\n")
    : ""

  const runWorkload = input.compose
    ? [
        `export AFK_COMMAND=${shellQuote(cmdShell)}`,
        `set -a; . "$AFK_ENV_FILE"; set +a`,
        `cd ${shellQuote(VM_AFK_DIR)}`,
        `timeout --preserve-status ${input.timeoutSeconds}s docker compose -f ${shellQuote(VM_COMPOSE_PATH)} \\`,
        `  up --exit-code-from ${shellQuote(input.mainService)} --abort-on-container-exit`,
        `RUN_EXIT=$?`,
        renderArtifactCollection(
          `$(docker compose -f ${shellQuote(VM_COMPOSE_PATH)} ps -aq ${shellQuote(input.mainService)})`,
          input,
        ),
        `docker compose -f ${shellQuote(VM_COMPOSE_PATH)} down -v --remove-orphans || true`,
      ]
        .filter((l) => l !== "")
        .join("\n")
    : [
        `timeout --preserve-status ${input.timeoutSeconds}s docker run ${collectArtifacts ? "" : "--rm "}\\`,
        `  --name ${shellQuote(input.mainService)} \\`,
        `  --env-file "$AFK_ENV_FILE" \\`,
        `  --log-driver gcplogs \\`,
        `  --log-opt labels=afk-run,afk-service \\`,
        `  --label afk-run=${shellQuote(input.runId)} \\`,
        `  --label afk-service=${shellQuote(input.mainService)} \\`,
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

  const registryHost = input.image.split("/")[0] ?? ""

  return [
    "#!/bin/bash",
    "set -uo pipefail",
    `echo "afk-startup: start run ${input.runId}"`,
    `export ${GCP_BACKEND_ENV}=gcp`,
    `export AFK_ZONE=${shellQuote(input.zone)}`,
    `export AFK_INSTANCE=${shellQuote(input.instanceName)}`,
    `export AFK_PROJECT_ID=${shellQuote(input.project)}`,
    "",
    `mkdir -p ${shellQuote(VM_AFK_DIR)}`,
    "",
    "# --- IMDS helpers (Container-Optimized OS has no gcloud SDK) ---",
    "# Every call to a Google API uses an OAuth2 access token fetched fresh from",
    "# the GCE metadata server. JSON parsing is intentionally tiny-regex — these",
    "# responses are flat objects so it's good enough, and avoids depending on",
    "# jq/python being present on the host image.",
    "afk_meta() { curl -fsS -H 'Metadata-Flavor: Google' \"http://metadata.google.internal/computeMetadata/v1/$1\"; }",
    `afk_token() { afk_meta 'instance/service-accounts/default/token' | sed -nE 's/.*"access_token":"([^"]+)".*/\\1/p'; }`,
    "",
    "# --- Pull agent image (instance SA has Artifact Registry read) ---",
    `AFK_TOKEN=$(afk_token)`,
    `echo "$AFK_TOKEN" | docker login -u oauth2accesstoken --password-stdin ${shellQuote(registryHost)}`,
    `docker pull ${shellQuote(input.image)}`,
    "",
    "# --- Build env file (plain + decrypted secrets) ---",
    `export AFK_ENV_FILE=${shellQuote(`${VM_AFK_DIR}/run.env`)}`,
    `export AFK_IMAGE=${shellQuote(input.image)}`,
    `: > "$AFK_ENV_FILE"`,
    `chmod 600 "$AFK_ENV_FILE"`,
    renderEnvFileWrites(input.env),
    renderSecretFetches(input.secretEnvNames, input.project),
    "",
    composeBlock,
    "",
    "# --- Run the workload under wall-clock cap ---",
    "set +e",
    runWorkload,
    "set -e",
    `echo "afk-startup: run exited $RUN_EXIT"`,
    "",
    "# --- Self-reclaim (max_run_duration is the backstop) ---",
    "# Fresh token: a long-running workload can outlive the boot-time one.",
    `AFK_TOKEN=$(afk_token)`,
    `curl -fsS -X DELETE -H "Authorization: Bearer $AFK_TOKEN" \\`,
    `  "https://compute.googleapis.com/compute/v1/projects/$AFK_PROJECT_ID/zones/$AFK_ZONE/instances/$AFK_INSTANCE" \\`,
    "  || true",
    "",
  ].join("\n")
}
