# AFK

A CLI to run AI development workloads inside your own cloud environment. Launch a coding agent in your AWS, GCP, or Cloudflare account and come back to the results.

```sh
# In any repo with an afk.Dockerfile:
afk init --provider aws                                    # point AFK at your cloud
afk golden build                                           # one-time: build the boot image
afk secrets put github-token <PAT>                         # so the Run can clone your repo
echo "GITHUB_TOKEN=secret:github-token" >> .afk.env
afk run "claude -p 'fix the failing test and open a PR'"   # launch an agent in your cloud
afk ls                                                     # see it running
afk logs <run-id>                                          # tail its output
```

That Run boots an ephemeral instance in your own AWS account, does the work, and terminates. The same commands work unchanged on GCP, Cloudflare, or your local Docker daemon.

## Documentation

Everything lives on the docs site: **<https://theodo-group.github.io/afk/>**

- [Introduction](https://theodo-group.github.io/afk/getting-started/introduction/) — what AFK is and the model behind it
- [How it works](https://theodo-group.github.io/afk/getting-started/how-it-works/) — the shape every Backend follows
- [Installation](https://theodo-group.github.io/afk/getting-started/installation/) — per-Backend prerequisites
- [Quickstart](https://theodo-group.github.io/afk/getting-started/quickstart/) — first Run on AWS, GCP, Cloudflare, or Local
- [CLI reference](https://theodo-group.github.io/afk/reference/cli/) — the full command surface
- [Consumer contract](https://theodo-group.github.io/afk/reference/consumer-contract/) — the files your repo must provide
- [Backends](https://theodo-group.github.io/afk/backends/overview/) — provisioning, attach, lifecycle, and cost per provider
- [Glossary](https://theodo-group.github.io/afk/concepts/glossary/) — the canonical vocabulary

## Install

AFK is not published to a registry; clone and link it:

```sh
git clone https://github.com/theodo-group/afk.git ~/afk
cd ~/afk/cli
bun install
bun link              # registers @afk/cli globally
```

Updating: `git pull && bun install`. Prerequisites (Bun, Docker, per-Backend tooling) are listed in the [installation guide](https://theodo-group.github.io/afk/getting-started/installation/).

## Repository layout

```
/
├── CONTEXT.md              # canonical glossary (source of truth for the docs site's glossary)
├── cli/                    # the TypeScript CLI, run with Bun
├── docs/                   # contributor docs (architecture, code style) + per-backend deep dives
├── entrypoint/             # CLI-injected container entrypoint (shared across Backends)
├── integrations/           # agent/tool integrations
├── terraform/              # copyable infra modules: aws/, gcp/ (afk init drops one into your repo)
├── website/                # the docs site (Astro Starlight)
└── worker/                 # copyable Cloudflare launcher Worker
```

Contributing? Start with [`CONTEXT.md`](./CONTEXT.md) for the domain language, then [`docs/architecture.md`](./docs/architecture.md) and [`docs/code-style.md`](./docs/code-style.md).

## License

Licensed under the [Apache License, Version 2.0](./LICENSE). Copyright 2026 Theodo Group.
