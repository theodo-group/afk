import { LOCAL_RUN_MOUNT } from "../../constants.ts"

/**
 * PID 1 of a local Run's outer container, baked into the local Golden Image.
 *
 * The CLI launches the outer container from the Golden Image with the per-Run
 * scratch dir (`~/.afk/runs/<runId>`) bind-mounted at ${LOCAL_RUN_MOUNT} and a
 * few `AFK_*` env vars set. This script starts rootless `dockerd` inside the
 * container, loads the baked sidecar cache + the agent image tar the CLI saved
 * onto the mount, runs the workload (compose or single container) under the
 * wall-clock timeout, streams output to `logs/` on the mount, and records the
 * exit code. The host reads logs straight off the mount; the daemon's record of
 * the outer container's exit is the Run's terminal state.
 *
 * It is re-entrant. When the Run finishes it writes the `exit` marker onto the
 * mount and the outer container stops — but is *retained* (not removed), so its
 * stopped inner containers + volumes survive as the Run's post-mortem state (see
 * CONTEXT.md "Retention"). `afk attach` resumes a retained Run by `docker
 * start`ing the outer container, which re-runs this script; the marker routes it
 * into resume mode, which revives the sidecars for inspection without re-running
 * the workload and idles until attach re-parks it.
 *
 * `\${...}` is escaped so the JS template literal leaves shell expansions intact.
 *
 * dockerd is started via the image's own `dockerd-entrypoint.sh` (which sets up
 * rootlesskit); the CLI runs the outer container `--privileged` so rootlesskit
 * can mount sysfs and create its network tap. Verified end-to-end (compose with
 * postgres + redis sidecars, source clone, clean teardown) on Docker 28.1.1.
 */
export const LOCAL_BOOTSTRAP = `#!/bin/sh
set -eu

RUN_DIR="\${AFK_RUN_DIR:-${LOCAL_RUN_MOUNT}}"
CACHE_DIR="\${AFK_GOLDEN_CACHE_DIR:-/var/afk/cache}"
LOG_DIR="\$RUN_DIR/logs"
DOCKERD_LOG="\$RUN_DIR/dockerd.log"
MAIN_SVC="\${AFK_MAIN_SERVICE:-agent}"
COMPOSE="\$RUN_DIR/compose.yml"
mkdir -p "\$LOG_DIR"

# Start the engine via the image's own rootless entrypoint (sets up
# rootlesskit, the user-namespace, and the data root). We point DOCKER_HOST at a
# writable rootless socket and disable TLS so our subsequent client calls reach
# the daemon over the unix socket. Both first-run and resume need the engine up.
export XDG_RUNTIME_DIR="\${XDG_RUNTIME_DIR:-/home/rootless/.docker/run}"
mkdir -p "\$XDG_RUNTIME_DIR"
export DOCKER_HOST="unix://\$XDG_RUNTIME_DIR/docker.sock"
export DOCKER_TLS_CERTDIR=""
echo "afk-local: starting rootless dockerd"
dockerd-entrypoint.sh dockerd >"\$DOCKERD_LOG" 2>&1 &
i=0
while [ \$i -lt 60 ]; do docker info >/dev/null 2>&1 && break; i=\$((i+1)); sleep 1; done
if ! docker info >/dev/null 2>&1; then
  echo "afk-local: dockerd did not become ready in 60s" >&2
  tail -n 200 "\$DOCKERD_LOG" >&2 || true
  echo 1 > "\$RUN_DIR/exit"
  exit 1
fi

# RESUME: a finished Run is being restarted by \`afk attach\` for post-mortem
# inspection (the exit marker is present). Revive the sidecars so the agent's
# post-mortem shell can reach them, but leave the main service stopped (starting
# it would re-run the developer's command), and never tear anything down. Then
# idle so the outer container stays up until attach re-parks it (\`docker stop\`).
if [ -f "\$RUN_DIR/exit" ]; then
  if [ -f "\$COMPOSE" ]; then
    for svc in \$(docker compose -f "\$COMPOSE" config --services 2>/dev/null); do
      if [ "\$svc" != "\$MAIN_SVC" ]; then
        docker compose -f "\$COMPOSE" start "\$svc" >/dev/null 2>&1 || true
      fi
    done
  fi
  echo "afk-local: resumed retained run for inspection"
  exec tail -f /dev/null
fi

# Hydrate the baked sidecar cache.
if [ -d "\$CACHE_DIR" ]; then
  for archive in "\$CACHE_DIR"/*.tar; do
    [ -e "\$archive" ] || continue
    docker load -i "\$archive" >/dev/null 2>&1 || echo "afk-local: warn: failed to load \$archive" >&2
  done
fi

# Load the wrapped agent image the CLI saved onto the mount (the Local analogue
# of the cloud registry pull).
if [ -f "\$RUN_DIR/agent-image.tar" ]; then
  echo "afk-local: loading agent image"
  docker load -i "\$RUN_DIR/agent-image.tar" >/dev/null 2>&1 || true
fi

ENV_FILE="\$RUN_DIR/run.env"
[ -f "\$ENV_FILE" ] || : > "\$ENV_FILE"
TIMEOUT="\${AFK_TIMEOUT_SECONDS:-14400}"
COMBINED="\$LOG_DIR/combined.log"
: > "\$COMBINED"

# Session Artifact collection (see CONTEXT.md). Best-effort, at graceful exit:
# copy each declared base dir out of the (just-exited) main service container
# onto the mount, where the host-side store applies the precise glob + size cap.
# A killed/SIGKILL'd Run never reaches this — a documented limitation. The base
# dirs (longest glob-free prefixes) are passed space-separated by the CLI.
ARTIFACT_DIR="\$RUN_DIR/session-artifacts"
collect_artifacts() {
  cref="\$1"
  [ -n "\${AFK_ARTIFACT_BASES:-}" ] || return 0
  [ -n "\$cref" ] || return 0
  mkdir -p "\$ARTIFACT_DIR"
  for base in \$AFK_ARTIFACT_BASES; do
    rel=\${base#/}
    parent="\$ARTIFACT_DIR/\$(dirname "\$rel")"
    mkdir -p "\$parent"
    if docker cp "\$cref:\$base" "\$parent/" 2>/dev/null; then
      echo "afk-local: collected session artifact base \$base"
    else
      echo "afk-local: no session artifact at \$base" >&2
    fi
  done
}

# Per-service log files are streamed LIVE (not just dumped on exit) so that
# \`afk logs <run>\` can scope to the main service while the Run is still alive,
# matching the cloud backends (AWS per-service CloudWatch streams, CF per-service
# capture). \`logs/<svc>.log\` = one service (no prefix); \`combined.log\` = every
# service (prefixed) for \`--all\`. The Run's lifetime is the main service's.
set +e
if [ -f "\$COMPOSE" ]; then
  export AFK_COMMAND
  export AFK_ENV_FILE="\$ENV_FILE"
  set -a; . "\$ENV_FILE"; set +a
  # depends_on / healthcheck conditions are honoured even when detached.
  docker compose -f "\$COMPOSE" up -d >>"\$COMBINED" 2>&1
  SVCS=\$(docker compose -f "\$COMPOSE" config --services 2>/dev/null)
  for svc in \$SVCS; do
    docker compose -f "\$COMPOSE" logs -f --no-log-prefix --no-color "\$svc" \\
      >"\$LOG_DIR/\$svc.log" 2>&1 &
  done
  docker compose -f "\$COMPOSE" logs -f --no-color >"\$COMBINED" 2>&1 &
  MAIN_CID=\$(docker compose -f "\$COMPOSE" ps -q "\$MAIN_SVC" 2>/dev/null)
  if [ -n "\$MAIN_CID" ]; then
    timeout "\$TIMEOUT" docker wait "\$MAIN_CID" >"\$RUN_DIR/exit.raw" 2>/dev/null
  fi
  RUN_EXIT=\$(cat "\$RUN_DIR/exit.raw" 2>/dev/null)
  [ -n "\$RUN_EXIT" ] || RUN_EXIT=124
  collect_artifacts "\$MAIN_CID"
else
  docker run -d --name "\$MAIN_SVC" --network host \\
    --env-file "\$ENV_FILE" "\$AFK_IMAGE" sh -c "\$AFK_COMMAND" >>"\$COMBINED" 2>&1
  docker logs -f --no-log-prefix "\$MAIN_SVC" >"\$LOG_DIR/\$MAIN_SVC.log" 2>&1 &
  docker logs -f "\$MAIN_SVC" >"\$COMBINED" 2>&1 &
  timeout "\$TIMEOUT" docker wait "\$MAIN_SVC" >"\$RUN_DIR/exit.raw" 2>/dev/null
  RUN_EXIT=\$(cat "\$RUN_DIR/exit.raw" 2>/dev/null)
  [ -n "\$RUN_EXIT" ] || RUN_EXIT=124
  collect_artifacts "\$MAIN_SVC"
fi
set -e

# The Run has ended. We deliberately do NOT tear the stack down: the stopped
# containers + their volumes are the retained Run's post-mortem state, which
# \`afk attach\` resumes for inspection. Writing the exit marker and returning
# stops the outer container, parking the primitive in its retained state; the
# reaper (\`afk run\`) and \`afk kill\` reclaim it later.
echo "\$RUN_EXIT" > "\$RUN_DIR/exit"
echo "afk-local: workload exited \$RUN_EXIT (retained for inspection)"
exit "\$RUN_EXIT"
`
