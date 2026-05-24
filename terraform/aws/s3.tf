# ---------------------------------------------------------------------------
# Session Artifacts bucket. Each Run VM uploads the developer-declared Session
# Artifacts (e.g. an agent's .jsonl transcript) to
# s3://<bucket>/<repo>/<runId>/session-artifacts/ before self-terminating; the
# CLI's `afk session-artifact` reads them back. The name is derived the same way
# the CLI derives it (afk-artifacts-<account>-<region>) so no output read is
# needed. force_destroy lets `afk destroy` remove it with its contents.
# ---------------------------------------------------------------------------

locals {
  artifacts_bucket = "afk-artifacts-${local.account_id}-${local.region}"
  artifacts_arn    = "arn:aws:s3:::${local.artifacts_bucket}"
}

variable "artifact_retention_days" {
  description = "Days to retain Session Artifacts in S3 before lifecycle expiry. Matches the CloudWatch log retention window."
  type        = number
  default     = 30
}

resource "aws_s3_bucket" "artifacts" {
  bucket        = local.artifacts_bucket
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket                  = aws_s3_bucket.artifacts.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  rule {
    id     = "expire-session-artifacts"
    status = "Enabled"
    filter {}
    expiration {
      days = var.artifact_retention_days
    }
  }
}

output "artifacts_bucket" {
  description = "S3 bucket Session Artifacts are uploaded to and retrieved from."
  value       = aws_s3_bucket.artifacts.id
}
