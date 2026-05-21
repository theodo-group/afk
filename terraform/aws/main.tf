terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Backend config is rendered into backend.tf by `afk init`. We declare the
  # backend type here so `terraform init` knows what to expect; the bucket,
  # key, region, and use_lockfile = true are written next to this file.
  backend "s3" {}
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
