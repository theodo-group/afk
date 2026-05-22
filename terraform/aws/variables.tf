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
