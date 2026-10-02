variable "aws_region" {
  description = "AWS region in which to provision all AFK resources."
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  description = "Prefix used to name AFK-owned AWS resources. Also surfaces in resource tags."
  type        = string
  default     = "afk"
}

variable "vpc_cidr" {
  description = "CIDR block for the dedicated AFK VPC."
  type        = string
  default     = "10.40.0.0/16"
}

variable "public_subnet_cidrs" {
  description = "CIDR blocks for the public subnets used by Run VMs. Must contain exactly two entries; each is mapped to a distinct AZ."
  type        = list(string)
  default     = ["10.40.0.0/24", "10.40.1.0/24"]

  validation {
    condition     = length(var.public_subnet_cidrs) == 2
    error_message = "public_subnet_cidrs must contain exactly two CIDR blocks (one per AZ)."
  }
}

variable "max_run_timeout_hours" {
  description = "Hard ceiling on Run wall-clock duration. The sweeper Lambda terminates VMs older than this + a grace window. The CLI rejects --timeout values above this."
  type        = number
  default     = 8
}

variable "allowed_instance_types" {
  description = "Instance types developers may launch Runs on. RunInstances is denied for any type outside this list."
  type        = list(string)
  default = [
    "t3.medium",
    "t3.large",
    "t3.xlarge",
    "m6a.large",
    "m6a.xlarge",
    "m6a.2xlarge",
    "m6a.4xlarge",
  ]
}

variable "sweeper_schedule_expression" {
  description = "EventBridge schedule for the sweeper Lambda."
  type        = string
  default     = "rate(15 minutes)"
}

variable "sweeper_grace_minutes" {
  description = "Grace period past a Run's declared timeout before the sweeper terminates the VM."
  type        = number
  default     = 30
}

variable "retention_days" {
  description = "Days a retained Run's stopped instance is kept (resumable via `afk attach`) before the sweeper reclaims it. Should match the CLI's retentionDays."
  type        = number
  default     = 7
}

variable "enable_session_logging" {
  description = "When true, SSM Session Manager sessions are recorded to CloudWatch under /afk/sessions. Off by default."
  type        = bool
  default     = false
}

variable "tags" {
  description = "Extra tags applied to every AFK-managed resource."
  type        = map(string)
  default     = {}
}

variable "scheduler_enabled" {
  description = "Deploy the scheduler Lambda, which ticks submitted Schedules and launches the Entries that are due. Off by default: the image is built and pushed at apply time, so turning it on makes `terraform apply` require Docker."
  type        = bool
  default     = false
}

variable "scheduler_tick_expression" {
  description = "EventBridge cadence of the scheduler's tick. This is afk's own wake interval, NOT a developer's Schedule — see CONTEXT.md 'Schedule'."
  type        = string
  default     = "rate(5 minutes)"
}

variable "scheduler_config_json" {
  description = "The project's afk.config.json, verbatim. The Lambda has no checkout to discover one in, so it writes this to disk at startup and runs the CLI against it."
  type        = string
  default     = ""
}

variable "scheduler_git_token_param" {
  description = "SSM parameter holding a read-only git token. The tick resolves each Entry's ref with `git ls-remote` at fire time, so a private origin needs a credential. Empty for a public origin."
  type        = string
  default     = ""
}
