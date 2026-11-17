import {
  AZURE_ARTIFACTS_CONTAINER,
  AZURE_BACKSTOP_GRACE_SECONDS,
  AZURE_LOG_SHIP_INTERVAL_SECONDS,
  AZURE_LOGS_CONTAINER,
  AZURE_RUNS_TABLE,
  AZURE_SECRET_PREFIX,
  AZURE_TAG_STOPPED_AT,
  GCP_BACKEND_ENV,
  VM_AFK_DIR,
  VM_COMPOSE_PATH,
} from "../../constants.ts"
import { RUNS_PARTITION } from "../../adapters/azure/AzStorage.ts"

/**
 * Functional core for the Azure Backend's VM custom data — the analogue of
 * `GcpStartupScript.ts`. Pure string assembly; cloud-init runs it once, as
 * root, on the VM's first boot. Because it runs *once per instance*, resuming a
 * retained Run boots the VM without re-running the workload — exactly the
 * post-mortem semantics of CONTEXT.md "Retention".
 *
 * Differences from the GCP startup-script, each forced by Azure:
 *   - Every Azure call is `az`, signed in as the VM's user-assigned managed
 *     identity (`az login --identity`) — the instance-SA analogue.
 *   - Azure has no Docker log driver of its own, so a background shipper
 *     re-uploads each service's `docker logs` to Blob storage every few seconds
 *     (the Cloudflare chunk-shipping shape), and marks the end with `.done`.
 *   - Azure has no `max_run_duration`, so a transient systemd timer armed at
 *     boot is the in-VM crash backstop; the sweeper Function backs it up.
 *   - Azure records no "last stopped" time, so a retained Run stamps it on its
 *     own tags before it deallocates — the retention window runs from it.
 *   - The VM writes its own completion row (status + exit code) to the Table
 *     Storage run index, as the AWS entrypoint does to DynamoDB.
 */
export interface AzureCustomDataInput {
  readonly runId: string
  readonly mainService: string
  readonly image: string
  readonly command: ReadonlyArray<string>
  readonly timeoutSeconds: number
  /** Retain on exit: keep the exited containers and deallocate, not delete. */
  readonly retain: boolean
  readonly env: ReadonlyArray<{ readonly name: string; readonly value: string }>
  /** Env-var name ↦ canonical secret name, read from Key Vault at boot. */
  readonly secretEnvNames: ReadonlyArray<{
    readonly name: string
    readonly secretName: string
  }>
  /** Compose YAML with ${AFK_IMAGE} already substituted. */
  readonly compose?: string
  readonly registry: string
  readonly keyVault: string
  readonly storageAccount: string
  readonly sessionArtifactBases: ReadonlyArray<string>
  readonly sessionArtifactPrefix: string
  readonly sessionArtifactMaxBytes: number
}

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

const LOG_DIR = `${VM_AFK_DIR}/logs`
const DONE_MARKER = `${VM_AFK_DIR}/run-done`
const RECLAIM_SCRIPT = `${VM_AFK_DIR}/reclaim.sh`

/**
 * Self-reclaim, shared by the normal exit path and the backstop timer. The VM
 * finds its own resource id through IMDS, so the script names nothing that
 * could drift from the VM actually running it.
 */
const renderReclaimScript = (retain: boolean): string =>
  [
    `cat > ${shellQuote(RECLAIM_SCRIPT)} <<'AFK_RECLAIM_EOF'`,
    "#!/bin/bash",
    'VM_ID=$(curl -s -H Metadata:true "http://169.254.169.254/metadata/instance/compute/resourceId?api-version=2021-02-01&format=text")',
    "az login --identity --output none --only-show-errors || true",
    ...(retain
      ? [
          // Retained: stamp the stop time, then deallocate — the OS disk and
          // the exited containers on it survive for post-mortem `afk attach`.
          `az tag update --resource-id "$VM_ID" --operation Merge --tags ${AZURE_TAG_STOPPED_AT}=$(date -u +%Y-%m-%dT%H:%M:%SZ) --output none --only-show-errors || true`,
          'az vm deallocate --ids "$VM_ID" --no-wait --output none --only-show-errors',
        ]
      : [
          'az vm delete --ids "$VM_ID" --yes --no-wait --output none --only-show-errors',
        ]),
    "AFK_RECLAIM_EOF",
    `chmod 700 ${shellQuote(RECLAIM_SCRIPT)}`,
  ].join("\n")

const renderEnvFileWrites = (
  env: ReadonlyArray<{ name: string; value: string }>,
): string =>
  env.length === 0
    ? "# (no plain env vars)"
    : env
        .map(
          (e) =>
            `printf '%s=%s\\n' ${shellQuote(e.name)} ${shellQuote(e.value)} >> "$AFK_ENV_FILE"`,
        )
        .join("\n")

const renderSecretFetches = (
  secrets: ReadonlyArray<{ name: string; secretName: string }>,
  keyVault: string,
): string =>
  secrets.length === 0
    ? "# (no secrets)"
    : secrets
        .map((s) =>
          [
            `_val=$(az keyvault secret show --vault-name ${shellQuote(keyVault)} --name ${shellQuote(`${AZURE_SECRET_PREFIX}-${s.secretName}`)} --query value --output tsv --only-show-errors)`,
            `printf '%s=%s\\n' ${shellQuote(s.name)} "$_val" >> "$AFK_ENV_FILE"`,
            "unset _val",
          ].join("\n"),
        )
        .join("\n")

/**
 * The log shipper: dump each service's log (plus the combined stream), and
 * upload whichever file changed since the last pass. Re-dumping whole logs is
 * quadratic in theory and negligible at an agent's output volumes; in return
 * every upload is the complete, ordered log, so a reader never stitches.
 */
const renderLogShipper = (input: AzureCustomDataInput): string => {
  const dump = input.compose
    ? [
        `  for svc in $(docker compose -f ${shellQuote(VM_COMPOSE_PATH)} config --services 2>/dev/null); do`,
        `    docker compose -f ${shellQuote(VM_COMPOSE_PATH)} logs --no-color --no-log-prefix "$svc" > "${LOG_DIR}/$svc.log" 2>/dev/null || true`,
        "  done",
        `  docker compose -f ${shellQuote(VM_COMPOSE_PATH)} logs --no-color > "${LOG_DIR}/combined.log" 2>/dev/null || true`,
      ]
    : [
        `  docker logs ${shellQuote(input.mainService)} > "${LOG_DIR}/${input.mainService}.log" 2>&1 || true`,
        `  cp "${LOG_DIR}/${input.mainService}.log" "${LOG_DIR}/combined.log"`,
      ]
  const upload = (file: string, blob: string) =>
    `az storage blob upload --account-name ${shellQuote(input.storageAccount)} --container-name ${AZURE_LOGS_CONTAINER} --name ${blob} --file ${file} --overwrite --auth-mode login --no-progress --output none --only-show-errors`
  return [
    "afk_ship_logs() {",
    ...dump,
    `  for f in "${LOG_DIR}"/*.log; do`,
    '    [ -f "$f" ] || continue',
    '    sum=$(md5sum "$f" | cut -d" " -f1)',
    '    [ "$sum" = "$(cat "$f.sum" 2>/dev/null)" ] && continue',
    `    ${upload('"$f"', `"${input.runId}/$(basename "$f")"`)} && echo "$sum" > "$f.sum"`,
    "  done",
    "}",
    "(",
    `  while [ ! -f ${shellQuote(DONE_MARKER)} ]; do afk_ship_logs; sleep ${AZURE_LOG_SHIP_INTERVAL_SECONDS}; done`,
    "  afk_ship_logs",
    `  : > "${LOG_DIR}/.done"`,
    `  ${upload(`"${LOG_DIR}/.done"`, `"${input.runId}/.done"`)} || true`,
    ") &",
    "AFK_SHIPPER=$!",
  ].join("\n")
}

const renderArtifactCollection = (
  containerRefExpr: string,
  input: AzureCustomDataInput,
): string => {
  if (input.sessionArtifactBases.length === 0) return ""
  const stage = `${VM_AFK_DIR}/session-artifacts`
  const bases = input.sessionArtifactBases.map(shellQuote).join(" ")
  return [
    "# --- Collect Session Artifacts (best-effort) ---",
    `AFK_ART_STAGE=${shellQuote(stage)}`,
    `AFK_CREF=${containerRefExpr}`,
    'if [ -n "$AFK_CREF" ]; then',
    '  mkdir -p "$AFK_ART_STAGE"',
    `  for base in ${bases}; do`,
    "    rel=${base#/}",
    '    parent="$AFK_ART_STAGE/$(dirname "$rel")"',
    '    mkdir -p "$parent"',
    '    docker cp "$AFK_CREF:$base" "$parent/" 2>/dev/null \\',
    '      && echo "afk-startup: collected session artifact $base" \\',
    '      || echo "afk-startup: no session artifact at $base"',
    "  done",
    `  find "$AFK_ART_STAGE" -type f -size +${input.sessionArtifactMaxBytes}c -print -delete 2>/dev/null \\`,
    "    | sed 's#^#afk-startup: skipped (over cap): #' || true",
    `  az storage blob upload-batch --account-name ${shellQuote(input.storageAccount)} --destination ${AZURE_ARTIFACTS_CONTAINER} --destination-path ${shellQuote(input.sessionArtifactPrefix.replace(/\/$/, ""))} --source "$AFK_ART_STAGE" --auth-mode login --no-progress --output none --only-show-errors \\`,
    '    && echo "afk-startup: uploaded session artifacts" \\',
    '    || echo "afk-startup: session artifact upload failed (non-fatal)"',
    "fi",
  ].join("\n")
}

const renderWorkload = (input: AzureCustomDataInput): string => {
  const cmdShell = input.command.join(" ")
  return input.compose
    ? [
        `export AFK_COMMAND=${shellQuote(cmdShell)}`,
        'set -a; . "$AFK_ENV_FILE"; set +a',
        `cd ${shellQuote(VM_AFK_DIR)}`,
        `timeout --preserve-status ${input.timeoutSeconds}s docker compose -f ${shellQuote(VM_COMPOSE_PATH)} \\`,
        `  up --exit-code-from ${shellQuote(input.mainService)} --abort-on-container-exit`,
        "RUN_EXIT=$?",
        renderArtifactCollection(
          `$(docker compose -f ${shellQuote(VM_COMPOSE_PATH)} ps -aq ${shellQuote(input.mainService)})`,
          input,
        ),
      ]
        .filter((l) => l !== "")
        .join("\n")
    : [
        // Never `--rm`: the shipper reads the exited container's log after
        // the workload ends; it is removed below once that last pass is done.
        `timeout --preserve-status ${input.timeoutSeconds}s docker run \\`,
        `  --name ${shellQuote(input.mainService)} \\`,
        '  --env-file "$AFK_ENV_FILE" \\',
        `  --label afk-run=${shellQuote(input.runId)} \\`,
        `  --label afk-service=${shellQuote(input.mainService)} \\`,
        `  ${shellQuote(input.image)} \\`,
        `  sh -c ${shellQuote(cmdShell)}`,
        "RUN_EXIT=$?",
        renderArtifactCollection(shellQuote(input.mainService), input),
      ]
        .filter((l) => l !== "")
        .join("\n")
}

// A retained Run keeps its exited containers and volumes for post-mortem
// attach (they go when the VM does); a non-retained Run tears down first.
const renderTeardown = (input: AzureCustomDataInput): string =>
  input.retain
    ? "# (retained — exited containers kept for post-mortem attach)"
    : input.compose
      ? `docker compose -f ${shellQuote(VM_COMPOSE_PATH)} down -v --remove-orphans || true`
      : `docker rm -f ${shellQuote(input.mainService)} >/dev/null 2>&1 || true`

const renderCompletionRow = (input: AzureCustomDataInput): string =>
  [
    'if [ "$RUN_EXIT" = 0 ]; then AFK_STATUS=stopped; else AFK_STATUS=failed; fi',
    `az storage entity merge --account-name ${shellQuote(input.storageAccount)} --table-name ${AZURE_RUNS_TABLE} \\`,
    `  --entity PartitionKey=${RUNS_PARTITION} RowKey=${shellQuote(input.runId)} status=$AFK_STATUS \\`,
    '  stopped_at=$(date -u +%Y-%m-%dT%H:%M:%SZ) exit_code="$RUN_EXIT" \\',
    "  --auth-mode login --output none --only-show-errors \\",
    '  || echo "afk-startup: could not record completion (non-fatal)"',
  ].join("\n")

export const buildAzureCustomData = (input: AzureCustomDataInput): string =>
  [
    "#!/bin/bash",
    "set -uo pipefail",
    `echo "afk-startup: start run ${input.runId}"`,
    `export ${GCP_BACKEND_ENV}=azure`,
    `mkdir -p ${shellQuote(LOG_DIR)}`,
    "",
    "# --- Sign in as the VM's managed identity (IMDS can lag the first boot) ---",
    "for _ in $(seq 1 30); do az login --identity --output none --only-show-errors && break; sleep 2; done",
    "",
    renderReclaimScript(input.retain),
    "",
    "# --- Backstop: Azure has no max-run-duration, so arm one in the VM ---",
    `systemd-run --unit=afk-backstop --on-active=${input.timeoutSeconds + AZURE_BACKSTOP_GRACE_SECONDS}s ${shellQuote(RECLAIM_SCRIPT)}`,
    "",
    "# --- Pull agent image (the identity holds AcrPull) ---",
    `az acr login --name ${shellQuote(input.registry)} --only-show-errors`,
    `docker pull ${shellQuote(input.image)}`,
    "",
    "# --- Build env file (plain + Key Vault secrets) ---",
    `export AFK_ENV_FILE=${shellQuote(`${VM_AFK_DIR}/run.env`)}`,
    `export AFK_IMAGE=${shellQuote(input.image)}`,
    ': > "$AFK_ENV_FILE"',
    'chmod 600 "$AFK_ENV_FILE"',
    renderEnvFileWrites(input.env),
    renderSecretFetches(input.secretEnvNames, input.keyVault),
    "",
    input.compose
      ? [
          `cat > ${shellQuote(VM_COMPOSE_PATH)} <<'AFK_COMPOSE_EOF'`,
          input.compose,
          "AFK_COMPOSE_EOF",
        ].join("\n")
      : "",
    "",
    "# --- Ship logs to Blob storage while the workload runs ---",
    renderLogShipper(input),
    "",
    "# --- Run the workload under wall-clock cap ---",
    "set +e",
    renderWorkload(input),
    `echo "afk-startup: run exited $RUN_EXIT"`,
    "",
    `touch ${shellQuote(DONE_MARKER)}`,
    'wait "$AFK_SHIPPER"',
    renderTeardown(input),
    "",
    "# --- Record completion in the run index ---",
    renderCompletionRow(input),
    "",
    input.retain
      ? "# --- Self-deallocate (retained for post-mortem; reaped after retention) ---"
      : "# --- Self-reclaim (the backstop timer and the sweeper back this up) ---",
    shellQuote(RECLAIM_SCRIPT),
    "",
  ].join("\n")
