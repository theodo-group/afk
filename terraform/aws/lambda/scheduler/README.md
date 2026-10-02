# scheduler

Lambda that ticks submitted [Schedules](../../../../CONTEXT.md) and launches the
Entries that are due.

Opt-in: everything here is gated on `scheduler_enabled` (default `false`),
because enabling it makes `terraform apply` build and push a container image and
therefore require Docker.

## Why a container image

The sweeper is an esbuild zip on `nodejs20`. The scheduler cannot be: afk is
Bun-only — `Bun.spawn` (`cli/src/infra/Subprocess.ts`), `Bun.Glob`
(`cli/src/services/SessionArtifact.ts`) and `@effect/platform-bun`. So the image
carries bun, plus `git` (the fire-time `git ls-remote` that resolves each
Entry's ref) and the AWS CLI v2 (every `adapters/aws/*` shells out to it).

There is no handler module. `bootstrap` is a custom-runtime loop that answers
each invocation with `afk schedule tick` — the same subcommand a developer runs
by hand, so there is one implementation of the rules rather than two.

## What it needs at runtime

| env | why |
|---|---|
| `AFK_CONFIG_JSON` | The Lambda has no checkout to discover an `afk.config.json` in. `bootstrap` writes this to `/tmp/project/` and runs the CLI from there, exactly where a developer's checkout would put it. |
| `AFK_GIT_TOKEN_PARAM` | SSM parameter holding a read-only git token, for a private origin. Empty for a public one. |

## Build

`null_resource.scheduler_image` builds and pushes at `terraform apply` time,
from the **repo root** as context (the Dockerfile copies `cli/` and
`entrypoint/` preserving their relative layout, which `BuildService`'s
entrypoint path resolution depends on).

The image tag is a hash of everything that ends up inside it, so a no-op apply
pushes nothing. To build by hand, from the repo root:

```sh
docker build --platform linux/amd64 \
  -f terraform/aws/lambda/scheduler/Dockerfile \
  -t <account>.dkr.ecr.<region>.amazonaws.com/afk/scheduler:dev .
```

## Testing a Schedule without deploying this

`afk schedule tick` runs one pass locally against the same tables. That is the
whole scheduler — deploy this only once the Schedule behaves.
