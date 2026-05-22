export const AFK_VPC_NAME = "afk-vpc"
export const AFK_SECURITY_GROUP = "afk-runs-sg"
export const AFK_VM_INSTANCE_ROLE = "afk-vm-instance-role"
export const AFK_VM_INSTANCE_PROFILE = "afk-vm-instance-profile"
export const AFK_DEVELOPER_ROLE = "afk-developer"
export const AFK_DEVELOPER_POLICY = "afk-developer"
export const AFK_ADMIN_POLICY = "afk-admin"
export const AFK_SWEEPER_ROLE = "afk-sweeper-role"
export const AFK_STATE_BUCKET_PREFIX = "afk-tf-state"

export const SSM_SECRET_PREFIX = "/afk/secrets"
export const SSM_RUNTIME_PREFIX = "/afk/runs"

export const ECR_REPO_PREFIX = "afk"
export const ECR_LIFECYCLE_DAYS = 7

export const LOG_GROUP_PREFIX = "/afk"
export const LOG_RETENTION_DAYS = 30

// Tags applied to every Run's EC2 instance.
export const TAG_OWNER = "afk:owner"
export const TAG_RUN_ID = "afk:run-id"
export const TAG_BRANCH = "afk:branch"
export const TAG_SHA = "afk:sha"
export const TAG_MANAGED = "afk:managed"
export const TAG_TIMEOUT_HOURS = "afk:timeout-hours"
export const TAG_STARTED_AT = "afk:started-at"
export const TAG_REPO = "afk:repo"

// Golden Image tags.
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
