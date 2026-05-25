# ---------------------------------------------------------------------------
# Enable the Google Cloud APIs every AFK capability depends on. Applied once
# per project. disable_on_destroy=false so `afk destroy` (terraform destroy)
# doesn't tear down APIs that other workloads in the project may rely on.
# ---------------------------------------------------------------------------

locals {
  required_apis = [
    "compute.googleapis.com",          # Run VMs, custom (golden) images, networking
    "iap.googleapis.com",              # IAP TCP tunnel for attach (no public IP)
    "secretmanager.googleapis.com",    # SecretStore
    "artifactregistry.googleapis.com", # ImageRegistry (Docker repo)
    "firestore.googleapis.com",        # RunHistory
    "logging.googleapis.com",          # LogStore (gcplogs driver + logging read)
    "cloudfunctions.googleapis.com",   # history-reconcile sweeper (gen2)
    "cloudscheduler.googleapis.com",   # sweeper trigger
    "run.googleapis.com",              # gen2 Cloud Functions run on Cloud Run
    "cloudbuild.googleapis.com",       # gen2 Cloud Functions build the source
    "iam.googleapis.com",              # custom role + bindings
    "iamcredentials.googleapis.com",   # service-account auth used by the function
  ]
}

resource "google_project_service" "required" {
  for_each = toset(local.required_apis)

  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}
