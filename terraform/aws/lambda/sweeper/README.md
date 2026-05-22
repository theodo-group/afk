# sweeper

Lambda that terminates AFK-managed EC2 instances past their declared timeout.

## Build

The Terraform `null_resource.sweeper_build` runs `npm install` + `npm run build`
at `terraform apply` time, producing `dist/index.js`. The `archive_file` data
source zips that into the deployment package.

To rebuild manually:

```sh
npm install
npm run build
```

Output: `dist/index.js` (bundled, CommonJS, Node 20, AWS SDK marked external —
the Lambda runtime provides v3).
