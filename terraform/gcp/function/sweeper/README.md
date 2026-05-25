# sweeper

Gen2 Cloud Function that reconciles orphaned AFK Run history rows in Firestore.
It flips `afk-runs` documents stuck in `status="RUNNING"` to `STOPPED` when their
backing Compute Engine instance no longer exists. It NEVER deletes VMs — GCE
`scheduling.max_run_duration` handles timeout-driven instance deletion.

## Build

The Terraform `null_resource.sweeper_build` runs `npm install` + `npm run build`
at `terraform apply` time, producing `dist/index.js` plus a runtime-only
`dist/package.json`. The `archive_file` data source zips `dist/` into the source
object the gen2 function deploys from (Cloud Build installs the runtime
`@google-cloud/*` deps from that package.json).

To rebuild manually:

```sh
npm install
npm run build
```

Output: `dist/index.js` (bundled, CommonJS, Node 20, `@google-cloud/*` marked
external — installed by Cloud Build) and `dist/package.json` (runtime manifest;
`main: index.js`, entry point export `sweeper`).
