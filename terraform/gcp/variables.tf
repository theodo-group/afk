variable "project_id" {
  description = "GCP project ID hosting all AFK resources."
  type        = string
}

variable "region" {
  description = "GCP region in which to provision regional AFK resources (subnet, NAT, Artifact Registry, Cloud Function)."
  type        = string
  default     = "us-central1"
}

variable "zone" {
  description = "GCP zone Run instances are launched into. Must be within var.region."
  type        = string
  default     = "us-central1-a"
}

variable "project_name" {
  description = "Prefix used to name AFK-owned GCP resources. Also surfaces in resource labels."
  type        = string
  default     = "afk"
}

variable "subnet_cidr" {
  description = "Primary CIDR range for the dedicated AFK subnet. Run instances draw internal IPs from this range; they get no external IP."
  type        = string
  default     = "10.40.0.0/20"
}

variable "max_run_timeout_hours" {
  description = "Hard ceiling on Run wall-clock duration. Enforced primarily by GCE scheduling.max_run_duration (instance self-deletes). The CLI rejects --timeout values above this."
  type        = number
  default     = 8
}

variable "allowed_machine_types" {
  description = "Machine types developers may launch Runs on. instances.create is denied for any type outside this list (enforced by the afk-developer IAM condition where expressible, and CLI-side)."
  type        = list(string)
  default = [
    "e2-medium",
    "e2-standard-2",
    "e2-standard-4",
    "n2-standard-2",
    "n2-standard-4",
    "n2-standard-8",
    "n2-standard-16",
  ]
}

variable "sweeper_schedule" {
  description = "Cloud Scheduler cron for the history-reconcile Cloud Function."
  type        = string
  default     = "*/5 * * * *"
}

variable "artifact_retention_days" {
  description = "Days to retain Session Artifacts in GCS before lifecycle expiry."
  type        = number
  default     = 30
}

variable "developer_member" {
  description = "IAM member the afk-developer role + IAP/OS-Login bindings are granted to (e.g. \"user:dev@example.com\", \"group:afk-devs@example.com\", or \"serviceAccount:...\"). `afk team add` adds further members at runtime."
  type        = string
}

variable "labels" {
  description = "Extra labels applied to every AFK-managed resource that supports labels."
  type        = map(string)
  default     = {}
}
