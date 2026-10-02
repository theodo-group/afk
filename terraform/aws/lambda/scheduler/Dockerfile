# ---------------------------------------------------------------------------
# Scheduler Lambda image.
#
# A container image rather than the sweeper's nodejs20 zip because afk is
# Bun-only: Bun.spawn (infra/Subprocess.ts), Bun.Glob (SessionArtifact.ts) and
# @effect/platform-bun are all load-bearing. The tick runs the real CLI, so the
# image also carries the AWS CLI (every AWS adapter shells out to it) and git
# (the fire-time `git ls-remote` that resolves each Entry's ref).
#
# Build context is the afk repo root — see scheduler.tf.
# ---------------------------------------------------------------------------
FROM public.ecr.aws/lambda/provided:al2023

RUN dnf install -y git tar gzip unzip findutils \
 && dnf clean all \
 && rm -rf /var/cache/dnf

# The AWS CLI v2: adapters/aws/* drive `aws` as a subprocess, not an SDK.
RUN curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" -o /tmp/awscliv2.zip \
 && unzip -q /tmp/awscliv2.zip -d /tmp \
 && /tmp/aws/install \
 && rm -rf /tmp/aws /tmp/awscliv2.zip

ENV BUN_INSTALL=/usr/local
RUN curl -fsSL https://bun.sh/install | bash

# Keep the repo's own layout: BuildService resolves ../../../entrypoint from
# cli/src/services, and the CLI resolves its imports relative to cli/.
COPY cli /opt/afk/cli
COPY entrypoint /opt/afk/entrypoint
RUN cd /opt/afk/cli && bun install --frozen-lockfile

COPY terraform/aws/lambda/scheduler/bootstrap /opt/afk/bootstrap
RUN chmod +x /opt/afk/bootstrap

ENTRYPOINT ["/opt/afk/bootstrap"]
