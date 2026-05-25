# ---------------------------------------------------------------------------
# Firestore (Native mode) — persistent Run history, the GCP analogue of the
# AWS DynamoDB afk-runs table. Rows are written by the CLI at `afk run` time
# and reconciled by the sweeper Cloud Function when a VM vanishes without
# writing its own completion.
#
# Documents live in the `afk-runs` collection, keyed by run_id. The two
# composite indexes below reproduce the DynamoDB GSIs:
#   by-owner:  owner ASC, started_at DESC   ("my runs in the last week")
#   by-repo:   repo  ASC, started_at DESC   ("runs for this repo")
#
# Other fields (not indexed): branch, sha, image, machine_type, zone, status,
# exit_code, stopped_at, instance_name, timeout_hours, owner_email.
# ---------------------------------------------------------------------------

resource "google_firestore_database" "afk" {
  name        = "(default)"
  project     = var.project_id
  location_id = var.region
  type        = "FIRESTORE_NATIVE"

  depends_on = [google_project_service.required]
}

resource "google_firestore_index" "by_owner" {
  project    = var.project_id
  database   = google_firestore_database.afk.name
  collection = "afk-runs"

  fields {
    field_path = "owner"
    order      = "ASCENDING"
  }

  fields {
    field_path = "started_at"
    order      = "DESCENDING"
  }
}

resource "google_firestore_index" "by_repo" {
  project    = var.project_id
  database   = google_firestore_database.afk.name
  collection = "afk-runs"

  fields {
    field_path = "repo"
    order      = "ASCENDING"
  }

  fields {
    field_path = "started_at"
    order      = "DESCENDING"
  }
}
