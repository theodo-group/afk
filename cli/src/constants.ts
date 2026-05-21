export const AFK_CLUSTER = "afk-cluster"
export const AFK_VPC_NAME = "afk-vpc"
export const AFK_SECURITY_GROUP = "afk-runs-sg"
export const AFK_TASK_EXECUTION_ROLE = "afk-task-execution"
export const AFK_TASK_ROLE = "afk-task"
export const AFK_DEVELOPER_ROLE = "afk-developer"
export const AFK_DEVELOPER_POLICY = "afk-developer"
export const AFK_ADMIN_POLICY = "afk-admin"
export const AFK_STATE_BUCKET_PREFIX = "afk-tf-state"

export const SSM_SECRET_PREFIX = "/afk/secrets"
export const SSM_RUNTIME_PREFIX = "/afk/runs"

export const ECR_REPO_PREFIX = "afk"
export const ECR_LIFECYCLE_DAYS = 7

export const LOG_GROUP_PREFIX = "/afk"
export const LOG_RETENTION_DAYS = 30

export const TAG_OWNER = "afk:owner"
export const TAG_RUN_ID = "afk:run-id"
export const TAG_BRANCH = "afk:branch"
export const TAG_SHA = "afk:sha"
export const TAG_MANAGED = "afk:managed"

export const DEFAULT_CPU = 1024
export const DEFAULT_MEMORY = 2048
export const DEFAULT_TIMEOUT_HOURS = 4

export const CONFIG_FILE = "afk.config.json"
export const ENV_FILE = ".afk.env"
