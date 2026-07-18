/**
 * PID 1 of a Cloudflare Run's Container instance, baked into the CF Golden Image
 * as its ENTRYPOINT.
 *
 * The RunDO boots the Container from the Golden Image and injects the per-Run
 * workload via the Container's environment: the wrapped agent image
 * (`AFK_IMAGE`), command, optional compose graph, a short-lived registry pull
 * credential, the workload env (`AFK_RUN_ENV_B64`), and the progress/complete
 * callback URLs + per-Run token. This is the CF analog of the AWS `user_data`
 * (`services/UserData.ts`): golden provides the engine, the workload runs inside
 * it. Unlike `user_data`, this script is *static* — every per-Run value arrives
 * at runtime via env, so it is baked into the image rather than rendered per Run
 * (and therefore folded into the Golden Image version hash so a change rotates
 * the tag — see `CloudflareGoldenPlan`).
 *
 * It starts root `dockerd` (`--bridge=none --iptables=false`, workloads on
 * `--network host` — CF's Firecracker microVM is the isolation boundary), loads
 * the baked sidecar cache, pulls the agent image, runs the workload (compose or
 * single container) under the wall-clock timeout, ships per-service log chunks
 * to the launcher while it runs (stored in R2 — live and untruncated), and
 * POSTs the exit code plus a budgeted per-service log map on completion (the
 * map is the fallback read path when no R2 chunks landed). Absent `AFK_IMAGE`
 * (e.g. an `afk attach --host` debug boot) it falls back to the container's
 * own CMD.
 *
 * `\${...}` is escaped so the JS template literal leaves shell expansions intact.
 */
export const CLOUDFLARE_BOOTSTRAP = `#!/bin/sh
# afk golden entrypoint — loads skopeo-baked OCI archives into rootless dockerd
# before handing off to the container's own command. The CF Container runtime
# invokes this as PID 1.
set -eu

CACHE_DIR="\${AFK_GOLDEN_CACHE_DIR:-/var/afk/cache}"
DOCKERD_LOG="\${AFK_DOCKERD_LOG:-/var/log/dockerd.log}"

# Start the Docker engine. On CF Containers (Firecracker microVM) the VM is
# the isolation boundary, so we run dockerd as ROOT with:
#   --exec-opt native.cgroupdriver=cgroupfs  (no systemd in the container)
#   --bridge=none --iptables=false           (CF blocks NAT/netfilter setup)
# and run workloads with --network host. (Rootless + slirp4netns is not viable
# here: /dev/net/tun is root-only and netns/netlink ops are denied to non-root.)
# This combination is verified working on Cloudflare Containers.
echo "afk-golden: starting dockerd"
dockerd --bridge=none --iptables=false --exec-opt native.cgroupdriver=cgroupfs \\
  >"\$DOCKERD_LOG" 2>&1 &
i=0
while [ \$i -lt 60 ]; do docker info >/dev/null 2>&1 && break; i=\$((i+1)); sleep 1; done
if ! docker info >/dev/null 2>&1; then
  echo "afk-golden: dockerd did not become ready in 60s" >&2
  tail -n 200 "\$DOCKERD_LOG" >&2 || true
  exit 1
fi

# Hydrate the daemon with our baked OCI archives.
if [ -d "\$CACHE_DIR" ]; then
  for archive in "\$CACHE_DIR"/*.tar; do
    [ -e "\$archive" ] || continue
    echo "afk-golden: loading \$archive"
    docker load -i "\$archive" || echo "afk-golden: warn: failed to load \$archive" >&2
  done
fi

echo "afk-golden: bootstrap complete"

# --- Run the per-Run workload, if one was injected -------------------------
# The RunDO passes the wrapped agent image + command + (optional) compose +
# a short-lived registry pull credential + the workload env (base64) via the
# Container's environment. This is the CF analog of the AWS user_data: golden
# provides the engine, the workload runs inside it. Absent these (e.g. an
# \`afk attach --host\` debug boot), we fall back to the container's own CMD.
if [ -n "\${AFK_IMAGE:-}" ]; then
  LOG=/var/afk/workload.log
  : > "\$LOG"

  ENV_FILE=/var/afk/run.env
  if [ -n "\${AFK_RUN_ENV_B64:-}" ]; then
    echo "\$AFK_RUN_ENV_B64" | base64 -d > "\$ENV_FILE"
  else
    : > "\$ENV_FILE"
  fi
  chmod 600 "\$ENV_FILE"

  # Authenticate to the CF managed registry with the minted pull credential.
  if [ -n "\${AFK_REGISTRY_PASSWORD:-}" ]; then
    echo "\$AFK_REGISTRY_PASSWORD" | timeout 60 docker login registry.cloudflare.com \\
      -u "\${AFK_REGISTRY_USER:-v1}" --password-stdin >>"\$LOG" 2>&1
  fi

  echo "afk-golden: pulling \$AFK_IMAGE" >>"\$LOG"
  timeout 600 docker pull "\$AFK_IMAGE" >>"\$LOG" 2>&1

  MAIN_SVC="\${AFK_MAIN_SERVICE:-agent}"

  # Materialise the compose graph (if any) and learn the service list up front —
  # the incremental log poller below starts BEFORE \`docker compose up\`.
  if [ -n "\${AFK_COMPOSE_YML:-}" ]; then
    mkdir -p /etc/afk
    printf '%s' "\$AFK_COMPOSE_YML" > /etc/afk/compose.yml
    SVCS=\$(docker compose -f /etc/afk/compose.yml config --services 2>/dev/null) || SVCS="\$MAIN_SVC"
  else
    SVCS="\$MAIN_SVC"
  fi

  # Snapshot every service's current logs into /var/afk/svc-<svc>.log. Called
  # periodically by the poller and once more after teardown.
  capture_services() {
    if [ -n "\${AFK_COMPOSE_YML:-}" ]; then
      for svc in \$SVCS; do
        docker compose -f /etc/afk/compose.yml logs --no-log-prefix --no-color "\$svc" \\
          > "/var/afk/svc-\$svc.log" 2>/dev/null || true
      done
    else
      cp "\$LOG" "/var/afk/svc-\$MAIN_SVC.log" 2>/dev/null || true
    fi
  }

  # Build the {"<svc>":"<base64>"} object from the captured files. Fallback
  # payload only (see /complete below): the live, untruncated copy ships as R2
  # chunks via ship_deltas. The budgets keep the fallback within DO-storage
  # value limits; the main service gets a larger budget than the sidecars.
  build_services_json() {
    printf '{'
    SEP=""
    for svc in \$SVCS; do
      f="/var/afk/svc-\$svc.log"
      [ -f "\$f" ] || continue
      if [ "\$svc" = "\$MAIN_SVC" ]; then BUDGET=131072; else BUDGET=32768; fi
      B64=\$(tail -c "\$BUDGET" "\$f" 2>/dev/null | base64 | tr -d '\\n')
      printf '%s"%s":"%s"' "\$SEP" "\$svc" "\$B64"
      SEP=","
    done
    printf '}'
  }

  # POST a JSON body to the launcher, carrying the per-Run token so the Worker
  # can authenticate the callback (the container has no CF Access creds).
  # post_json_ok reports failure to the caller; post_json is fire-and-forget.
  post_json_ok() {
    wget -qO- --header="Content-Type: application/json" \\
      --header="X-AFK-Run-Token: \${AFK_COMPLETE_TOKEN:-}" \\
      --post-data="\$2" "\$1" >/dev/null 2>&1
  }
  post_json() {
    post_json_ok "\$1" "\$2" || true
  }

  # Ship each service's not-yet-shipped log bytes to the launcher as a numbered
  # chunk (stored in R2 by the Worker, concatenated on read — so \`afk logs\` is
  # live and untruncated). Offsets and sequence numbers persist in files because
  # the poller subshell and the final main-shell flush must share them. A failed
  # POST leaves the offset untouched, so the same bytes re-ship next round.
  ship_deltas() {
    [ -n "\${AFK_LOGS_URL:-}" ] || return 0
    for svc in \$SVCS; do
      f="/var/afk/svc-\$svc.log"
      [ -f "\$f" ] || continue
      off=\$(cat "/var/afk/off-\$svc" 2>/dev/null || echo 0)
      size=\$(wc -c < "\$f")
      [ "\$size" -gt "\$off" ] || continue
      seq=\$(( \$(cat "/var/afk/seq-\$svc" 2>/dev/null || echo 0) + 1 ))
      B64=\$(tail -c +\$((off+1)) "\$f" | base64 | tr -d '\\n')
      if post_json_ok "\$AFK_LOGS_URL" \\
        "\$(printf '{"service":"%s","seq":%s,"b64":"%s"}' "\$svc" "\$seq" "\$B64")"; then
        echo "\$seq" > "/var/afk/seq-\$svc"
        echo "\$size" > "/var/afk/off-\$svc"
      fi
    done
  }

  # Session Artifact collection (see CONTEXT.md). Best-effort, at graceful exit:
  # docker cp each declared base dir out of the (just-exited, not-yet-removed)
  # main container, drop files over the cap (skip, never truncate), tar+gzip the
  # staged tree and POST it base64-encoded to the launcher, which stores it in
  # R2. \$1 is the main container ref (id on compose, name on the single run).
  collect_and_upload_artifacts() {
    cref="\$1"
    [ -n "\${AFK_ARTIFACT_BASES:-}" ] || return 0
    [ -n "\${AFK_ARTIFACT_URL:-}" ] || return 0
    [ -n "\$cref" ] || return 0
    ASTAGE=/var/afk/session-artifacts
    mkdir -p "\$ASTAGE"
    for base in \$AFK_ARTIFACT_BASES; do
      rel=\${base#/}
      parent="\$ASTAGE/\$(dirname "\$rel")"
      mkdir -p "\$parent"
      docker cp "\$cref:\$base" "\$parent/" 2>/dev/null \\
        && echo "afk-golden: collected session artifact \$base" \\
        || echo "afk-golden: no session artifact at \$base"
    done
    find "\$ASTAGE" -type f -size +\${AFK_ARTIFACT_MAX_BYTES:-26214400}c -delete 2>/dev/null || true
    if [ -n "\$(ls -A "\$ASTAGE" 2>/dev/null)" ]; then
      TARB64=\$(tar czf - -C "\$ASTAGE" . 2>/dev/null | base64 | tr -d '\\n')
      post_json "\$AFK_ARTIFACT_URL" "\$(printf '{"tarGzB64":"%s"}' "\$TARB64")"
      echo "afk-golden: uploaded session artifacts"
    fi
  }

  # Incremental log push: while the workload runs, ship the per-service byte
  # deltas every few seconds so \`afk logs --follow\` streams a live Run rather
  # than waiting for exit. Chunks land in R2 via AFK_LOGS_URL; against an older
  # launcher Worker (no AFK_LOGS_URL injected) fall back to the legacy growing
  # budgeted snapshot on AFK_PROGRESS_URL.
  POLLER_PID=""
  if [ -n "\${AFK_LOGS_URL:-}" ] || [ -n "\${AFK_PROGRESS_URL:-}" ]; then
    (
      set +e
      while true; do
        sleep "\${AFK_LOG_PUSH_INTERVAL:-5}"
        capture_services
        if [ -n "\${AFK_LOGS_URL:-}" ]; then
          ship_deltas
        else
          post_json "\$AFK_PROGRESS_URL" "\$(printf '{"services":%s}' "\$(build_services_json)")"
        fi
      done
    ) &
    POLLER_PID=\$!
  fi

  TIMEOUT="\${AFK_TIMEOUT_SECONDS:-14400}"
  set +e
  if [ -n "\${AFK_COMPOSE_YML:-}" ]; then
    # Export the vars the compose file interpolates: \${AFK_COMMAND} and
    # \${AFK_ENV_FILE} (the env_file: path), plus source the env for the rest.
    export AFK_COMMAND
    export AFK_ENV_FILE="\$ENV_FILE"
    set -a; . "\$ENV_FILE"; set +a
    timeout "\$TIMEOUT" docker compose -f /etc/afk/compose.yml \\
      up --exit-code-from "\$MAIN_SVC" --abort-on-container-exit \\
      >>"\$LOG" 2>&1
    RUN_EXIT=\$?
  else
    # --network host: child containers share the CF container's network (no
    # bridge/NAT is available — see dockerd flags above). \`--rm\` is dropped
    # when collecting Session Artifacts so the exited container survives for
    # \`docker cp\`; it is removed explicitly after collection.
    if [ -n "\${AFK_ARTIFACT_BASES:-}" ]; then AFK_RM=""; else AFK_RM="--rm"; fi
    timeout "\$TIMEOUT" docker run \$AFK_RM --name "\$MAIN_SVC" --network host \\
      --env-file "\$ENV_FILE" "\$AFK_IMAGE" sh -c "\$AFK_COMMAND" \\
      >>"\$LOG" 2>&1
    RUN_EXIT=\$?
  fi

  # Stop the poller and take a final snapshot BEFORE compose teardown removes
  # the containers, so the per-service payload is complete. Ship the last chunk
  # now — after teardown the logs are gone.
  [ -n "\$POLLER_PID" ] && kill "\$POLLER_PID" 2>/dev/null || true
  capture_services
  ship_deltas
  # Collect Session Artifacts before teardown removes the exited main container.
  if [ -n "\${AFK_COMPOSE_YML:-}" ]; then
    collect_and_upload_artifacts "\$(docker compose -f /etc/afk/compose.yml ps -aq "\$MAIN_SVC" 2>/dev/null)"
    docker compose -f /etc/afk/compose.yml down -v --remove-orphans >/dev/null 2>&1 || true
  else
    collect_and_upload_artifacts "\$MAIN_SVC"
    [ -n "\${AFK_ARTIFACT_BASES:-}" ] && docker rm -f "\$MAIN_SVC" >/dev/null 2>&1 || true
  fi

  cat "\$LOG" 2>/dev/null || true
  echo "afk-golden: workload exited \$RUN_EXIT"

  # Final callback: exit code + the budgeted per-service log map. The Worker
  # flips the Run to STOPPED; the map is only the fallback read path — when R2
  # chunks exist (ship_deltas above) the Worker serves those instead.
  if [ -n "\${AFK_COMPLETE_URL:-}" ]; then
    post_json "\$AFK_COMPLETE_URL" \\
      "\$(printf '{"exitCode":%s,"services":%s}' "\$RUN_EXIT" "\$(build_services_json)")"
  fi
  exit "\$RUN_EXIT"
fi

echo "afk-golden: no AFK_IMAGE; exec \$@"
exec "\$@"
`
