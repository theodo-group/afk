# ---------------------------------------------------------------------------
# Artifact Registry — the Docker repository AFK pushes per-build agent images
# to. Registry URI is <region>-docker.pkg.dev/<project_id>/<repo>. The CLI
# tags images afk/<source-repo>:<sha> within this single repo; the instance SA
# has read access (iam.tf), developers push via `afk build`.
# ---------------------------------------------------------------------------

resource "google_artifact_registry_repository" "afk" {
  location      = var.region
  repository_id = var.project_name
  description   = "AFK agent images"
  format        = "DOCKER"

  depends_on = [google_project_service.required]
}
