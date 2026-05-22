terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.0"
    }
    null = {
      source  = "hashicorp/null"
      version = "~> 3.0"
    }
  }

  # Backend block is rendered into backend.tf by `afk init` (not declared here
  # to avoid a "duplicate backend configuration" error).
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = merge(var.tags, {
      ManagedBy = "afk"
      Project   = var.project_name
    })
  }
}

data "aws_caller_identity" "current" {}

data "aws_availability_zones" "available" {
  state = "available"
}
