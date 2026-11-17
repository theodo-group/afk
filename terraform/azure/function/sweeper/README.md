# sweeper

Timer-triggered Azure Function (Node 22, v4 programming model) that keeps the
Azure Backend tidy. Every 5 minutes, over the afk-managed VMs of the afk
resource group, it:

1. **reclaims overrun Runs** — Azure has no native max-run-duration, so each
   Run VM arms a systemd timer at boot; this is the backstop for a VM that
   hung or never armed it (deleted, or deallocated when retained);
2. **reaps retained Runs** — deallocated `afk-retain` VMs older than
   `RETENTION_DAYS` past their `afk-stopped-at` stamp;
3. **reconciles the run index** — `afkruns` rows still `running` whose VM is
   gone become `stopped`.

## Build

`null_resource.sweeper_build` runs `npm install` + `npm run build` at
`terraform apply` time: esbuild bundles `index.ts` and every dependency into
`dist/index.js`, next to `host.json` and a runtime `package.json`. The
`archive_file` data source zips `dist/` and the Function App zip-deploys it.

```sh
npm install
npm run build
```
