output "project_id" {
  description = "GCP project hosting AFK."
  value       = var.project_id
}

output "region" {
  description = "Region in which AFK is provisioned."
  value       = var.region
}

output "zone" {
  description = "Zone Run instances are launched into."
  value       = var.zone
}

output "network" {
  description = "AFK VPC network self-link."
  value       = google_compute_network.afk.id
}

output "subnetwork" {
  description = "AFK subnet Run instances are launched into."
  value       = google_compute_subnetwork.afk.id
}

output "run_network_tag" {
  description = "Network tag every Run VM must carry for the IAP-SSH firewall rule to apply."
  value       = "${var.project_name}-run"
}

output "vm_service_account_email" {
  description = "Service account attached to every Run VM."
  value       = google_service_account.vm.email
}

output "developer_role_id" {
  description = "Custom IAM role granting AFK developer permissions. Bind to developer principals via `afk team add`."
  value       = google_project_iam_custom_role.developer.id
}

output "artifact_registry_repo" {
  description = "Artifact Registry Docker repository URI AFK pushes agent images to."
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.afk.repository_id}"
}

output "artifacts_bucket" {
  description = "GCS bucket Session Artifacts are uploaded to and retrieved from."
  value       = google_storage_bucket.artifacts.name
}

output "runs_collection" {
  description = "Firestore collection holding persistent Run history."
  value       = "afk-runs"
}

output "sweeper_function_name" {
  description = "Name of the history-reconcile Cloud Function."
  value       = google_cloudfunctions2_function.sweeper.name
}

output "allowed_machine_types" {
  description = "Whitelist of machine types developers may launch Runs on."
  value       = var.allowed_machine_types
}

output "max_run_timeout_hours" {
  description = "Hard ceiling on Run duration. CLI rejects --timeout values above this."
  value       = var.max_run_timeout_hours
}
