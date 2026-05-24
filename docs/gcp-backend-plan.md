# Implementation Plan: GCP (Compute Engine) Backend

A new cloud Backend that follows the AWS one-VM-per-Run shape. No command or
orchestrating-service changes — everything lands behind the nine
`services/backend/` tags plus one `cli.ts` branch (`docs/architecture.md`,
"Adding a Backend").

## Decisions (resolved in grilling, recorded in CONTEXT.md)

| Concern | Decision |
|---|---|
| Compute primitive | One Compute Engine instance per Run, booted from a GCE **custom image**, configured via **startup-script**. |
| **Owner** principal | Authenticated **gcloud account** (user or service-account email) from `gcloud auth`. Stamped as the `afk-owner` GCE label (email sanitized to label rules), raw email kept in the history row for display. |
| **Attach / connectivity** | **IAP TCP tunnel + OS Login**. No public IP, no internet-facing SSH. `gcloud compute ssh --tunnel-through-iap` → `docker exec`. Access gated by `roles/iap.tunnelResourceAccessor`. |
| **Reclaim** | Entrypoint **self-deletes** the VM on command exit (instance SA scoped to delete only `afk-managed` VMs). Timeout backstop = GCE native **`scheduling.max_run_duration` + `instance_termination_action=DELETE`** — no instance-reaping sweeper. |
| **History reconcile** | A **minimal** Cloud Function (Cloud Scheduler, ~5 min) that *only* rewrites orphaned `RUNNING` rows to `STOPPED` for VMs that vanished without writing completion. It never deletes VMs. |
| RunHistory store | **Firestore (Native mode)**; composite indexes reproduce the two DynamoDB GSIs (`owner+started_at`, `repo+started_at`). |
| LogStore | Docker **`gcplogs`** driver injected per compose service (labelled `runId`+`service`); `afk logs` reads via `gcloud logging read` label filter. |
| ImageRegistry | **Artifact Registry** Docker repo. |
| SecretStore | **Secret Manager** (`afk-<name>`); injected via instance SA `secretmanager.secretAccessor`. |
| SessionArtifactStore | **Cloud Storage** bucket; entrypoint uploads main-service artifacts before self-delete. |
| GoldenImage | **GCE custom image** built by snapshotting a short-lived builder VM's disk after it pre-pulls the configured image list. |
| Provisioner / TF state | `terraform/gcp/` applied via gcloud-authed Terraform; **GCS bucket** for remote state. |
| Team | Bind/unbind existing org principals to the `afk-developer` role (+ `iap.tunnelResourceAccessor`, OS Login). No principal *creation*. |
| Retention | None — reclaim immediately (matches AWS/CF; Local is the only retention backend). |

## Shared wiring changes (outside `backends/gcp/`)

1. **`schema/Config.ts`**
   - `BackendName` literal union → add `"gcp"` (currently `Schema.Literal("aws","cloudflare","local")`, `Config.ts:64`).
   - Add `GcpBackendConfig` mirroring `AwsBackendConfig` (`Config.ts:6`):
     ```ts
     export const GcpBackendConfig = Schema.Struct({
       projectId: Schema.optional(Schema.String),
       region: Schema.optional(Schema.String),
       zone: Schema.optional(Schema.String),
       defaultMachineType: Schema.optional(Schema.String),
       allowedMachineTypes: Schema.optional(Schema.Array(Schema.String)),
       cachedImages: Schema.optional(Schema.Array(Schema.String)),
     })
     ```
   - Add `gcp: Schema.optional(GcpBackendConfig)` to `AfkConfig` (`Config.ts:67`).

2. **`projectConfig.ts`** — `pickBackendName` (`projectConfig.ts:45`): add
   `if (parsed.backend === "gcp") return "gcp"` and widen the return type to include `"gcp"`.

3. **`cli.ts`** — extend the backend ternary (`cli.ts:115`) with a
   `backendName === "gcp" ? GcpBackendLive.pipe(Layer.provideMerge(configLayer)) : …` branch.
   `GcpBackendLive` has gcloud/GCS external deps (not AWS SDK), so it is its own
   fully-resolved `backendLayer` exactly like the existing three.

4. **`infra/Errors.ts`** — add `GcpError` following `CloudflareError` (`Errors.ts:55`,
   `{ operation, message }`) and add it to the `AfkError` union (`Errors.ts:61`).

5. **`schema/Run.ts`** — no change needed; `backend` is already typed as
   `BackendName`, which now admits `"gcp"`. `RunStatus` literals
   (`PROVISIONING|RUNNING|STOPPING|STOPPED`) are sufficient — a GCE instance's
   `PROVISIONING/STAGING/RUNNING/STOPPING/TERMINATED` collapses onto them.

## New adapters — `cli/src/adapters/gcp/`

Mirror `adapters/aws/awsCli.ts:48` (`makeAwsCli`). One `makeGcloudCli(sub)`
factory wrapping `Subprocess` with `.json<T>`, `.run`, `.text`, `.exists`, each
piping `Effect.mapError(gcpError(operation))`. All shelling stays in
`infra/Subprocess.ts` (`code-style.md` §5).

| Adapter | gcloud surface | Backs |
|---|---|---|
| `Gce.ts` | `gcloud compute instances create/list/describe/delete`, `images create/list/delete` | Compute, GoldenImage |
| `ArtifactRegistry.ts` | `gcloud artifacts repositories …`, `gcloud auth configure-docker` | ImageRegistry |
| `SecretManager.ts` | `gcloud secrets create/versions add/delete/list` | SecretStore |
| `CloudLogging.ts` | `gcloud logging read` (+ `--format`, follow loop) | LogStore |
| `Firestore.ts` | Firestore REST/`gcloud firestore` (put/get/query docs) | RunHistory |
| `Gcs.ts` | `gcloud storage cp/rsync/rm`, bucket create | SessionArtifactStore, TF state |
| `Iam.ts` | `gcloud projects add/remove-iam-policy-binding`, OS Login | Team |
| `Auth.ts` | `gcloud auth list`, `config get-value account/project` | Owner principal (`callerPrincipal`) |
| `Iap.ts` (or fold into `Gce`) | `gcloud compute ssh --tunnel-through-iap` (interactive) | attach |

`attach` uses `Subprocess.runInteractive` (TTY, no kill finalizer); log follow
uses `Subprocess.stream` (kill on interruption) — per `code-style.md` §5.

## New backend implementations — `cli/src/backends/gcp/`

One `Layer.effect` per tag, each `Xxx.of({…})`. Implements the nine
`services/backend/` tags.

- **`GcpRunPlan.ts` (pure core)** — mirror `AwsRunPlan.ts` (the
  functional-core/imperative-shell exemplar, `code-style.md` §4):
  - `planGcpRun(input): Either<GcpRunCore, UserError>` — resolve project/region/zone,
    machine type (whitelist-validated against `allowedMachineTypes`), labels
    (`afk-run-id`, `afk-owner`, `afk-branch`, `afk-sha`, `afk-managed=true`),
    startup-script, `max_run_duration` from `timeoutSeconds`.
  - `gceInstanceToRun(instance): Run | null` — translate `instances describe`
    JSON (read labels) → `Run`, collapsing GCE status → `RunStatus`.
  - `finalizeGcpPlan(core, placement): PreparedRun` — inject network (subnet/SA/
    no-external-IP) and seal `backendPlan`. Declare the backendPlan payload a
    closed `type` (not `interface`) so the `Record<string,unknown>` round-trips
    with a single `as` (`code-style.md` §4).
  - Tested by `GcpRunPlan.test.ts` with **no Layer** (pure in/out).

- **`GcpCompute.ts` (shell)** — `prepare` gathers config + `Auth.callerPrincipal`
  + golden image + compose, generates `runId`/`startedAt`, calls `planGcpRun`,
  then effects (ensure log sink/labels, resolve network placement). `--dry-run`
  stops after `prepare`. `launch` casts `backendPlan`, calls `gce.createInstance`,
  records start to Firestore via `RunHistory`, returns `RunStarted`
  (`backendDetails` = `{machineType, zone}`, `logChannel` = the logging filter).
  `kill` = `instances delete`. `attach` = IAP SSH → `docker exec`. Consumes
  `RunHistory`/`GoldenImageStore` as intra-backend deps (provided via `index.ts`).

- **`GcpImageRegistry.ts`** — Artifact Registry: `registryUri`, `ensureRepoAndAuth`
  (`repositories create` idempotent + `auth configure-docker`), `imageExists`,
  `listLatestTagsByPrefix`, `push`.
- **`GcpSecretStore.ts`** — Secret Manager CRUD over `afk-*`.
- **`GcpLogStore.ts`** — `tail` builds a `gcloud logging read` filter on
  `labels.afk_run` (+ `labels.afk_service` unless `--all`), follow loop for `-f`.
- **`GcpRunHistory.ts`** — Firestore `recordStart` / `recordComplete` / `query`
  (composite-index reads for owner/repo). Shared with the sweeper function.
- **`GcpGoldenImage.ts`** — `build` (via `GcpGoldenPlan.ts` pure core, mirroring
  `AwsGoldenPlan.ts`): boot builder VM, startup-script pre-pulls `cachedImages`,
  `images create` from disk, label `afk-golden=true`, delete builder.
  `findLatest`/`list`/`remove` query labelled images.
- **`GcpSessionArtifactStore.ts`** — `fetch` = `gcloud storage rsync` from
  `gs://<bucket>/<repo>/<runId>/session-artifacts/`.
- **`GcpTeam.ts`** — `add`/`rm` = IAM policy-binding add/remove for the
  `afk-developer` role (+ IAP + OS Login) on an existing principal; `ls` reads
  bindings. `AddMemberResult` reports "bound", not "created".
- **`GcpProvisioner.ts`** — runs Terraform in `terraform/gcp/`, streams steps
  through the `Output` tag.
- **`GcpBackendDoctor.ts`** — mirror `AwsBackendDoctor.ts:10`: binary probes
  (`gcloud`, `terraform`); `gcloud components`/IAP TCP support present; identity
  check via `Auth` (`gcloud auth list` active account + project set); APIs
  enabled (compute, iap, secretmanager, artifactregistry, firestore, logging).

- **`index.ts`** — aggregate, mirroring `backends/aws/index.ts`:
  ```ts
  const Leaves = Layer.mergeAll(
    GcpImageRegistryLive, GcpSecretStoreLive, GcpLogStoreLive,
    GcpRunHistoryLive, GcpGoldenImageLive, GcpBackendDoctorLive,
    GcpTeamLive, GcpSessionArtifactStoreLive,
  )
  export const GcpBackendLive = GcpComputeLive.pipe(Layer.provideMerge(Leaves))
  ```

## Terraform — `terraform/gcp/`

Mirror `terraform/aws/` structure.

- **`network.tf`** — VPC + subnet, **no external IPs** on Run instances, firewall
  allowing only IAP's TCP range (`35.235.240.0/20`) on 22, Cloud NAT for egress
  (image pulls, gcloud self-delete).
- **`iam.tf`**
  - *Instance service account* (`afk-vm`): Artifact Registry read, Secret Manager
    accessor (`afk-*`), Logging writer, GCS object create (artifacts), and
    `compute.instances.delete` **conditioned on the `afk-managed` label** (self-delete only).
  - *Developer role* (`afk-developer`): `compute.instances.create` conditioned on
    golden image + afk subnet + machine-type whitelist + `afk-owner` == caller;
    `compute.instances.delete` / IAP tunnel / OS Login scoped to `afk-owner` == caller.
- **`firestore.tf`** — database (Native) + the two composite indexes.
- **`storage.tf`** — artifacts bucket + TF-state GCS bucket.
- **`sweeper.tf`** — Cloud Function (built from `terraform/gcp/function/sweeper/`,
  TS, plain SDK like `terraform/aws/lambda/sweeper/`) + Cloud Scheduler (5 min).
  **History-reconcile only**: list `afk-managed` VMs, find `RUNNING` Firestore rows
  with no live VM, rewrite to `STOPPED` (exitCode null). Does *not* delete VMs.
- **`artifactregistry.tf`**, **`apis.tf`** (enable required services).

## Entrypoint

`entrypoint/entrypoint.sh` is CLI-owned and shared. Add a GCP branch (or detect
via injected env) for the self-reclaim step: on command exit, after artifact
upload, run `gcloud compute instances delete "$(hostname)" --zone=… --quiet`
(parallels the AWS `shutdown -h now`). History `recordComplete` (or the upload of
a completion marker the function reads) must happen **before** delete — once the
VM is gone nothing else writes its row except the reconcile function.

## Docs

- `docs/backends/gcp.md` — user-facing guide (alongside `aws.md`/`cloudflare.md`):
  prereqs (gcloud, IAP, OS Login), `afk init --provider gcp`, config block, IAM
  prerequisites, attach via IAP.
- CONTEXT.md already updated (Owner, Golden Image, Backend list).

## Suggested phasing

1. **Wiring skeleton** — Config `gcp` block + `BackendName`, `pickBackendName`,
   `cli.ts` branch, `GcpError`, empty `GcpBackendLive` returning `UserError("not implemented")`. Compiles, selectable.
2. **`adapters/gcp/` + `Auth`/`Gce`** and **`GcpRunPlan.ts` + test** (pure core first).
3. **Compute prepare/launch/kill** + **RunHistory (Firestore)** → `afk run --dry-run`, then real launch + `afk ls`.
4. **LogStore, attach (IAP), SessionArtifacts** → `afk logs`/`afk attach`.
5. **GoldenImage (+ GcpGoldenPlan test)**, **ImageRegistry**, **SecretStore**.
6. **Provisioner + `terraform/gcp/`**, **Team**, **Doctor**, **sweeper function**.
7. **`docs/backends/gcp.md`**.

## Open implementation notes (not blocking design)

- Email→label sanitization: lowercase, replace `@`/`.` with `_`, ≤63 chars; store
  raw email in the Firestore row. Confirm collision-safety (prefix-hash if needed).
- OS Login maps the gcloud principal to a POSIX user automatically; verify
  `docker exec` works under that user (docker group / sudo on the golden image).
- `max_run_duration` requires the instance be created with `instance_termination_action=DELETE`; confirm it applies to standard (non-Spot) VMs in target regions.
