export const AFK_VPC_NAME = "afk-vpc"
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
