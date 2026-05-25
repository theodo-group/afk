# afk.Dockerfile recipe — Claude Code agent
#
# Copy this file to your project root as `afk.Dockerfile` and append any
# project-specific toolchain lines below. The CLI injects ENTRYPOINT at build
# time and clones source into /workspace at Run start — leave both alone.
#
# Verified against: node:20-bookworm, Claude Code latest.

FROM node:20-bookworm

# Base utilities. ca-certificates for HTTPS, git for the entrypoint's clone,
# unzip for tarball extraction (Bun installer, etc.), jq for ad-hoc agent
# scripts, make + sudo to match what most repos' Makefiles assume.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git gnupg unzip jq make sudo \
    && rm -rf /var/lib/apt/lists/*

# Bun — handy for one-off scripts the agent writes and runs in-Run.
RUN curl -fsSL https://bun.sh/install | bash \
    && ln -sf /root/.bun/bin/bun  /usr/local/bin/bun \
    && ln -sf /root/.bun/bin/bunx /usr/local/bin/bunx

# Claude Code itself. Pin a version (`@x.y.z`) when reproducibility matters
# more than auto-upgrades.
RUN npm install -g @anthropic-ai/claude-code

# Append project-specific layers below this line:
#   - language runtimes (php, ruby, python, go, …)
#   - package managers (composer, pnpm, poetry, …)
#   - cloud / VCS CLIs (gh, glab, aws, gcloud, …)
#   - project-specific build tools

# CLI-injected ENTRYPOINT clones the workspace here at Run start — leave
# this directory writable and don't COPY source code.
WORKDIR /workspace
