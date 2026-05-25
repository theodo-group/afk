#!/usr/bin/env bash
# AFK Run entrypoint.
#
# Injected into every consumer image at build time by the CLI. Not authored
# or vendored by consumers.
#
# Contract:
#   - Required env: AFK_GIT_URL, AFK_GIT_REF, GITHUB_TOKEN
#   - Optional env: AFK_GIT_SHA, AFK_TIMEOUT_SECONDS (default 14400), AFK_RUN_ID
#   - Args ("$@"): the developer's command, exec'd after setup
#
# Exit codes:
#   0       developer command exited 0
#   1-124   developer command's own exit code
#   124     wall-clock timeout (from `timeout`)
#   64      missing required env
#   65      git clone or checkout failed
#   66      AFK_GIT_SHA mismatch (resolved ref != expected sha)

set -euo pipefail

log() { printf '[afk] %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit "${2:-1}"; }

: "${AFK_GIT_URL:?AFK_GIT_URL is required}" 2>/dev/null || die "AFK_GIT_URL is required" 64
: "${AFK_GIT_REF:?AFK_GIT_REF is required}" 2>/dev/null || die "AFK_GIT_REF is required" 64

# Pick the auth token + HTTP-Basic username from the git host. GitHub uses
# `x-access-token:<pat>`; GitLab (saas + self-hosted) uses `oauth2:<pat>`.
git_host="$(printf '%s' "${AFK_GIT_URL}" | sed -E 's#^https?://([^/]+)/.*#\1#')"
case "${git_host}" in
  github.com|*.github.com)
    : "${GITHUB_TOKEN:?GITHUB_TOKEN is required}" 2>/dev/null || die "GITHUB_TOKEN is required" 64
    git_user="x-access-token"
    git_token="${GITHUB_TOKEN}"
    ;;
  *gitlab*|*.gitlab.com|gitlab.com)
    : "${GITLAB_TOKEN:?GITLAB_TOKEN is required}" 2>/dev/null || die "GITLAB_TOKEN is required" 64
    git_user="oauth2"
    git_token="${GITLAB_TOKEN}"
    ;;
  *)
    # Unknown host — accept whichever token is set, prefer GitHub for back-compat.
    if [[ -n "${GITHUB_TOKEN:-}" ]]; then
      git_user="x-access-token"; git_token="${GITHUB_TOKEN}"
    elif [[ -n "${GITLAB_TOKEN:-}" ]]; then
      git_user="oauth2"; git_token="${GITLAB_TOKEN}"
    else
      die "no GITHUB_TOKEN or GITLAB_TOKEN set for host ${git_host}" 64
    fi
    ;;
esac

WORKSPACE="${AFK_WORKSPACE:-/workspace}"
TIMEOUT_SECONDS="${AFK_TIMEOUT_SECONDS:-14400}"
RUN_ID="${AFK_RUN_ID:-unknown}"

log "Run ${RUN_ID} starting"
log "Cloning ${AFK_GIT_URL} @ ${AFK_GIT_REF} into ${WORKSPACE}"

mkdir -p "${WORKSPACE}"

# Build an authenticated clone URL without ever printing the token.
auth_url="$(printf '%s' "${AFK_GIT_URL}" \
  | sed -E "s#^https://#https://${git_user}:${git_token}@#")"

if ! git clone --quiet "${auth_url}" "${WORKSPACE}" 2>&1 \
    | sed "s#${git_token}#***#g" >&2; then
  die "git clone failed" 65
fi

cd "${WORKSPACE}"

if ! git -c advice.detachedHead=false checkout --quiet "${AFK_GIT_REF}"; then
  die "git checkout ${AFK_GIT_REF} failed" 65
fi

# Verify the resolved sha matches what the CLI expected, if provided.
if [[ -n "${AFK_GIT_SHA:-}" ]]; then
  actual_sha="$(git rev-parse HEAD)"
  if [[ "${actual_sha}" != "${AFK_GIT_SHA}" ]]; then
    die "ref ${AFK_GIT_REF} resolved to ${actual_sha}, expected ${AFK_GIT_SHA}" 66
  fi
fi

# Scrub the token from the remote so the dev's command can't accidentally leak
# it via `git remote -v` output piped somewhere.
git remote set-url origin "${AFK_GIT_URL}"
unset GITHUB_TOKEN GITLAB_TOKEN

log "Workspace ready at $(git rev-parse HEAD)"
log "Executing command under ${TIMEOUT_SECONDS}s timeout: $*"

# Forward SIGTERM cleanly. `timeout --foreground` ensures signals reach the
# child process group; `--kill-after` sends SIGKILL if SIGTERM is ignored.
exec timeout --foreground --kill-after=30s "${TIMEOUT_SECONDS}" "$@"
