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
  description = "CIDR blocks for the public subnets used by Fargate Runs. Must contain exactly two entries; each is mapped to a distinct AZ."
  type        = list(string)
  default     = ["10.40.0.0/24", "10.40.1.0/24"]

  validation {
    condition     = length(var.public_subnet_cidrs) == 2
    error_message = "public_subnet_cidrs must contain exactly two CIDR blocks (one per AZ)."
  }
}

variable "max_run_timeout_hours" {
  description = "Hard ceiling on Run wall-clock duration. Enforced by the entrypoint wrapper; the CLI rejects --timeout values above this."
  type        = number
  default     = 8
}

variable "enable_exec_logging" {
  description = "When true, ECS Exec sessions are recorded to CloudWatch under /afk/exec. Off by default to keep baseline cost at zero."
  type        = bool
  default     = false
}

variable "tags" {
  description = "Extra tags applied to every AFK-managed resource."
  type        = map(string)
  default     = {}
}
