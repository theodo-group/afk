# ---------------------------------------------------------------------------
# History-reconcile Cloud Function (gen2) + Cloud Scheduler trigger.
#
# Code lives in function/sweeper/. Bundled with esbuild at `terraform apply`
# time (mirrors terraform/aws/lambda/sweeper). Two jobs: flip orphaned RUNNING
# Firestore rows to STOPPED when their VM no longer exists, and reap retained
# Runs (stopped afk-retain VMs) past the retention window. Timeout deletion of
# live Runs is still GCE-native (max_run_duration).
# ---------------------------------------------------------------------------

locals {
  sweeper_src_dir = "${path.module}/function/sweeper"
  sweeper_dist    = "${path.module}/function/sweeper/dist"
}

resource "null_resource" "sweeper_build" {
  triggers = {
    source = filesha256("${local.sweeper_src_dir}/index.ts")
    pkg    = filesha256("${local.sweeper_src_dir}/package.json")
  }

  provisioner "local-exec" {
    working_dir = local.sweeper_src_dir
    command     = "npm install --silent && npm run build --silent"
  }
}

data "archive_file" "sweeper" {
  type        = "zip"
  source_dir  = local.sweeper_dist
  output_path = "${path.module}/function/sweeper/dist.zip"

  depends_on = [null_resource.sweeper_build]
}

# --- Source object the gen2 function deploys from ---

resource "google_storage_bucket" "sweeper_source" {
  name                        = "${var.project_name}-sweeper-src-${var.project_id}"
  location                    = var.region
  force_destroy               = true
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  depends_on = [google_project_service.required]
}

resource "google_storage_bucket_object" "sweeper_source" {
  name   = "sweeper-${data.archive_file.sweeper.output_md5}.zip"
  bucket = google_storage_bucket.sweeper_source.name
  source = data.archive_file.sweeper.output_path
}

# --- Function service account: list VMs + reconcile Firestore, nothing else ---

resource "google_service_account" "sweeper" {
  account_id   = "${var.project_name}-sweeper"
  display_name = "AFK history-reconcile function"

  depends_on = [google_project_service.required]
}

# List Compute Engine instances for history reconcile, plus delete to reap
# retained Runs (afk-retain VMs left stopped past the retention window). Delete
# is project-wide because the afk-retain label is not an IAM-condition attribute
# (same gap as the developer/vm roles); the function only ever targets stopped
# instances carrying afk-managed=true + afk-retain=true, enforced in code.
resource "google_project_iam_custom_role" "sweeper" {
  role_id     = "${replace(var.project_name, "-", "_")}_sweeper"
  title       = "AFK sweeper"
  description = "List Compute Engine instances for reconcile; delete to reap expired retained Runs."
  permissions = [
    "compute.instances.list",
    "compute.instances.get",
    "compute.instances.delete",
    "compute.zoneOperations.get",
  ]
}

resource "google_project_iam_member" "sweeper_compute" {
  project = var.project_id
  role    = google_project_iam_custom_role.sweeper.id
  member  = "serviceAccount:${google_service_account.sweeper.email}"
}

# Firestore read + write on the afk-runs collection (project-level user role;
# Firestore IAM is not per-collection).
resource "google_project_iam_member" "sweeper_firestore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.sweeper.email}"
}

# --- The function (gen2) ---

resource "google_cloudfunctions2_function" "sweeper" {
  name     = "${var.project_name}-sweeper"
  location = var.region

  build_config {
    runtime     = "nodejs20"
    entry_point = "sweeper"
    source {
      storage_source {
        bucket = google_storage_bucket.sweeper_source.name
        object = google_storage_bucket_object.sweeper_source.name
      }
    }
  }

  service_config {
    max_instance_count    = 1
    available_memory      = "256M"
    timeout_seconds       = 120
    service_account_email = google_service_account.sweeper.email

    environment_variables = {
      AFK_PROJECT_ID      = var.project_id
      AFK_RUNS_COLLECTION = "afk-runs"
      RETENTION_DAYS      = tostring(var.retention_days)
    }
  }

  depends_on = [
    google_project_service.required,
    google_firestore_database.afk,
  ]
}

# --- Cloud Scheduler: invoke the function on a cron (default every 5 min) ---

# SA the scheduler uses to authenticate the OIDC call to the function's
# underlying Cloud Run service.
resource "google_service_account" "sweeper_invoker" {
  account_id   = "${var.project_name}-sweeper-invoker"
  display_name = "AFK sweeper Cloud Scheduler invoker"

  depends_on = [google_project_service.required]
}

resource "google_cloud_run_service_iam_member" "sweeper_invoker" {
  location = google_cloudfunctions2_function.sweeper.location
  service  = google_cloudfunctions2_function.sweeper.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.sweeper_invoker.email}"
}

resource "google_cloud_scheduler_job" "sweeper" {
  name      = "${var.project_name}-sweeper"
  schedule  = var.sweeper_schedule
  time_zone = "Etc/UTC"
  region    = var.region

  http_target {
    http_method = "POST"
    uri         = google_cloudfunctions2_function.sweeper.url

    oidc_token {
      service_account_email = google_service_account.sweeper_invoker.email
      audience              = google_cloudfunctions2_function.sweeper.url
    }
  }

  depends_on = [google_cloud_run_service_iam_member.sweeper_invoker]
}
