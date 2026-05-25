export const AFK_VPC_NAME = "afk-vpc"
export const AFK_SUBNET_NAME = "afk-subnet"
// GCE network tag stamped on every afk-managed VM (golden builder + Runs). The
// IAP-SSH allow rule and deny-ingress rule both target this tag — a VM created
// without it is invisible to IAP and cannot be `afk attach`-ed into.
export const AFK_RUN_NETWORK_TAG = "afk-run"
export const AFK_SECURITY_GROUP = "afk-runs-sg"
export const AFK_VM_INSTANCE_ROLE = "afk-vm-instance-role"
export const AFK_VM_INSTANCE_PROFILE = "afk-vm-instance-profile"
export const AFK_DEVELOPER_ROLE = "afk-developer"
export const AFK_DEVELOPER_POLICY = "afk-developer"
export const AFK_ADMIN_POLICY = "afk-admin"
export const AFK_SWEEPER_ROLE = "afk-sweeper-role"
export const AFK_STATE_BUCKET_PREFIX = "afk-tf-state"
// Per-account/region S3 bucket Session Artifacts are shipped to on the AWS
// Backend (Terraform-managed; see terraform/aws/s3.tf). Name derived the same
// way as the state bucket: `<prefix>-<accountId>-<region>`.
export const AFK_ARTIFACTS_BUCKET_PREFIX = "afk-artifacts"

export const SSM_SECRET_PREFIX = "/afk/secrets"
export const SSM_RUNTIME_PREFIX = "/afk/runs"

export const ECR_REPO_PREFIX = "afk"
export const ECR_LIFECYCLE_DAYS = 7

export const LOG_GROUP_PREFIX = "/afk"
export const LOG_RETENTION_DAYS = 30

// ---------- Session Artifacts ----------
//
// A matched file larger than this is skipped with a warning rather than
// truncated — partial JSONL is worse than none (see CONTEXT.md "Session
// Artifact"). Generous default; collection is opt-in regardless.
export const SESSION_ARTIFACT_MAX_BYTES = 25 * 1024 * 1024

// Subdir/prefix the collected files land under: on Local the per-Run scratch
// dir (`~/.afk/runs/<id>/<dir>`), on the cloud Backends the per-Run storage
// prefix. Kept identical across Backends so the retrieval seam is uniform.
export const SESSION_ARTIFACT_DIR = "session-artifacts"

// Tags applied to every Run's EC2 instance.
export const TAG_OWNER = "afk:owner"
export const TAG_RUN_ID = "afk:run-id"
export const TAG_BRANCH = "afk:branch"
export const TAG_SHA = "afk:sha"
export const TAG_MANAGED = "afk:managed"
export const TAG_TIMEOUT_HOURS = "afk:timeout-hours"
export const TAG_STARTED_AT = "afk:started-at"
export const TAG_REPO = "afk:repo"
/** Retention window (days) for a stopped on-demand Run; read by the sweeper. */
export const TAG_RETENTION_DAYS = "afk:retention-days"

export const TAG_GOLDEN = "afk:golden"
export const TAG_GOLDEN_VERSION = "afk:golden-version"
export const TAG_GOLDEN_BUILT_AT = "afk:built-at"
export const TAG_GOLDEN_CACHED_IMAGES = "afk:cached-images"

export const DEFAULT_INSTANCE_TYPE = "t3.medium"
export const DEFAULT_ALLOWED_INSTANCE_TYPES = [
  "t3.medium",
  "t3.large",
  "t3.xlarge",
  "m6a.large",
  "m6a.xlarge",
  "m6a.2xlarge",
  "m6a.4xlarge",
] as const
export const DEFAULT_TIMEOUT_HOURS = 4
export const DEFAULT_MAIN_SERVICE = "agent"
/** Days a finished Run's compute primitive is retained before reclamation.
 * Honoured by the Local Backend only; cloud Backends self-reclaim on exit. */
export const DEFAULT_RETENTION_DAYS = 7
export const DEFAULT_REGION = "us-east-1"

// Golden image staleness threshold for `afk doctor`.
export const GOLDEN_IMAGE_STALE_DAYS = 30

// Sweeper grace window past the declared timeout.
export const SWEEPER_GRACE_MINUTES = 30

export const CONFIG_FILE = "afk.config.json"
export const ENV_FILE = ".afk.env"
export const COMPOSE_FILE = "afk.compose.yml"
export const DOCKERFILE = "afk.Dockerfile"

// Substitution token the dev places in afk.compose.yml for the main-service image.
export const AFK_IMAGE_PLACEHOLDER = "${AFK_IMAGE}"

// User_data conventions on the VM.
export const VM_AFK_DIR = "/etc/afk"
export const VM_COMPOSE_PATH = "/etc/afk/compose.yml"

// ---------- Local Backend ----------
//
// Docker container labels are the Local Backend's truth source — the analogue
// of the `afk:*` EC2 tags. Label keys can't contain ':' the way tags do, so we
// use the dotted `afk.*` convention Docker recommends.
export const LABEL_OWNER = "afk.owner"
export const LABEL_RUN_ID = "afk.run-id"
export const LABEL_BRANCH = "afk.branch"
export const LABEL_SHA = "afk.sha"
export const LABEL_MANAGED = "afk.managed"
export const LABEL_REPO = "afk.repo"
export const LABEL_TIMEOUT_HOURS = "afk.timeout-hours"
export const LABEL_STARTED_AT = "afk.started-at"
export const LABEL_IMAGE = "afk.image"
export const LABEL_MAIN_SERVICE = "afk.main-service"

// The single principal every local Run is owned by (single-machine backend —
// see CONTEXT.md "Owner"). Ownership scoping is a no-op locally.
export const LOCAL_OWNER_ID = "local"

// Local Golden Image repository (an image in the developer's own daemon, never
// pushed to a registry). Tagged `<repo>:<version>` like the cloud artifacts.
export const LOCAL_GOLDEN_REPO = "afk-golden-local"

// Inside the outer dind container the bootstrap writes here; this path is the
// bind-mounted per-Run scratch dir (host side: ~/.afk/runs/<runId>).
export const LOCAL_RUN_MOUNT = "/var/afk/run"

// Socket the inner rootless dockerd listens on (XDG_RUNTIME_DIR/docker.sock for
// the `rootless` user). A `docker exec` shell into the outer container does not
// inherit the bootstrap's exported DOCKER_HOST, so `afk attach` must set it to
// talk to the inner daemon.
export const LOCAL_INNER_DOCKER_HOST =
  "unix:///home/rootless/.docker/run/docker.sock"

// ---------- GCP Backend ----------
//
// GCE instance labels are the GCP Backend's truth source — the analogue of the
// `afk:*` EC2 tags. GCE label keys can't contain ':' and must be lowercase
// [a-z0-9_-], so we use the dash convention CONTEXT.md records (`afk-owner`).
export const GCP_LABEL_OWNER = "afk-owner"
export const GCP_LABEL_RUN_ID = "afk-run-id"
export const GCP_LABEL_BRANCH = "afk-branch"
export const GCP_LABEL_SHA = "afk-sha"
export const GCP_LABEL_MANAGED = "afk-managed"
export const GCP_LABEL_REPO = "afk-repo"
export const GCP_LABEL_TIMEOUT_HOURS = "afk-timeout-hours"
export const GCP_LABEL_STARTED_AT = "afk-started-at"
export const GCP_LABEL_GOLDEN = "afk-golden"
export const GCP_LABEL_GOLDEN_VERSION = "afk-golden-version"

// Label values share the same [a-z0-9_-]{0,63} restriction and cannot hold an
// email's `@`/`.` or a git ref's `/`. Values are sanitized to this charset on
// write; the raw value is preserved in the Firestore history row for display.
export const GCP_LABEL_VALUE_MAX = 63

export const GCP_DEFAULT_REGION = "us-central1"
export const GCP_DEFAULT_ZONE = "us-central1-a"
export const GCP_DEFAULT_MACHINE_TYPE = "e2-standard-4"
export const GCP_DEFAULT_ALLOWED_MACHINE_TYPES = [
  "e2-standard-2",
  "e2-standard-4",
  "e2-standard-8",
  "n2-standard-4",
  "n2-standard-8",
] as const

// Artifact Registry Docker repo holding the per-build agent images and the
// Golden custom image is keyed by family below. The custom image family lets
// `findLatest` resolve the newest image without listing+sorting by hand.
export const GCP_ARTIFACT_REPO = "afk"
export const GCP_GOLDEN_IMAGE_FAMILY = "afk-golden"

// Secret Manager secret names are flat (no '/'), so the SSM `/afk/secrets/<n>`
// path collapses to `afk-secret-<n>`.
export const GCP_SECRET_PREFIX = "afk-secret"

// Firestore collection holding the run index (the DynamoDB `afk-runs` analogue).
export const GCP_RUNS_COLLECTION = "afk-runs"

// GCS bucket prefixes (suffixed with the project id): Session Artifacts + the
// terraform remote-state bucket.
export const GCP_ARTIFACTS_BUCKET_PREFIX = "afk-artifacts"
export const GCP_STATE_BUCKET_PREFIX = "afk-tf-state"

// The afk-developer custom role and the per-Run instance service account.
export const GCP_DEVELOPER_ROLE = "afkDeveloper"
export const GCP_VM_SERVICE_ACCOUNT = "afk-vm"

// IAP brokers the SSH tunnel; this is the env var the startup-script exports so
// the CLI-owned entrypoint can self-delete the instance on exit.
export const GCP_BACKEND_ENV = "AFK_BACKEND"
