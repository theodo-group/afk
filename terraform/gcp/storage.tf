# ---------------------------------------------------------------------------
# Cloud Storage buckets.
#
#   - artifacts: each Run uploads the developer-declared Session Artifacts
#     (e.g. an agent's .jsonl transcript) to
#     gs://<bucket>/<repo>/<runId>/session-artifacts/ before self-deleting;
#     `afk session-artifact` reads them back. The instance SA has objectCreator
#     only. The name is derived the same way the CLI derives it
#     (afk-artifacts-<project_id>) so no output read is needed.
#
# The GCS remote-state bucket is deliberately NOT managed here: it must exist
# before `terraform init` can initialise the gcs backend, so `afk init` creates
# it (mirroring how the AWS module leaves its S3 state bucket to `afk init`).
# ---------------------------------------------------------------------------

locals {
  artifacts_bucket = "${var.project_name}-artifacts-${var.project_id}"
}

resource "google_storage_bucket" "artifacts" {
  name                        = local.artifacts_bucket
  location                    = var.region
  force_destroy               = true
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  lifecycle_rule {
    condition {
      age = var.artifact_retention_days
    }
    action {
      type = "Delete"
    }
  }

  depends_on = [google_project_service.required]
}
