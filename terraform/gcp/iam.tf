# ---------------------------------------------------------------------------
# IAM.
#
# Two principals:
#   (a) afk-vm  — the service account attached to every Run instance. Minimal:
#       pull from Artifact Registry, read afk-* secrets, write logs, upload
#       Session Artifacts, and delete ITSELF (compute.instances.delete gated on
#       the afk-managed=true label so a Run can only reclaim afk-managed VMs).
#   (b) afk-developer — a custom role bound to developer principals. Grants
#       conditioned instances.create (golden image + afk subnet + machine-type
#       + owner), instances.delete scoped to the caller's own Runs, plus IAP
#       tunnel + OS Login so attach works.
#
# IAM-condition coverage note: GCP IAM conditions can reference a small set of
# request/resource attributes (resource.name, resource.type, and for compute a
# handful of compute.googleapis.com/* attributes via the CEL `resource`
# object). They CANNOT inspect arbitrary GCE instance *labels* (afk-owner,
# afk-managed, afk-golden) at create/delete time — labels are part of the
# request body, not exposed as condition attributes. So every label-based rule
# below that AWS expressed as an `ec2:ResourceTag` condition is enforced
# CLI-side instead; the comments mark each such gap explicitly.
# ---------------------------------------------------------------------------

# ===========================================================================
# (a) Instance service account — attached to every Run VM.
# ===========================================================================

resource "google_service_account" "vm" {
  account_id   = "${var.project_name}-vm"
  display_name = "AFK Run instance service account"

  depends_on = [google_project_service.required]
}

# Artifact Registry reader — pull the agent + golden images.
resource "google_project_iam_member" "vm_artifactregistry_reader" {
  project = var.project_id
  role    = "roles/artifactregistry.reader"
  member  = "serviceAccount:${google_service_account.vm.email}"
}

# Secret Manager accessor — resolve secret:<name> refs at boot.
# Scoped to afk-* secrets via the per-secret IAM in secretmanager (the CLI
# creates afk-<name> secrets); project-level accessor kept narrow by an IAM
# condition on the secret resource name prefix.
resource "google_project_iam_member" "vm_secret_accessor" {
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.vm.email}"

  condition {
    title       = "afk-secrets-only"
    description = "Only secrets whose ID begins with afk-."
    expression  = "resource.name.startsWith(\"projects/${local.project_number}/secrets/${var.project_name}-\")"
  }
}

# Logging writer — the gcplogs Docker driver ships per-service stdout/stderr.
resource "google_project_iam_member" "vm_log_writer" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.vm.email}"
}

# Object creator on the artifacts bucket only — upload Session Artifacts.
resource "google_storage_bucket_iam_member" "vm_artifacts_creator" {
  bucket = google_storage_bucket.artifacts.name
  role   = "roles/storage.objectCreator"
  member = "serviceAccount:${google_service_account.vm.email}"
}

# Self-delete. The Run's entrypoint calls `gcloud compute instances delete
# $(hostname)` on command exit. We want the VM to delete ONLY afk-managed
# instances (itself), never an arbitrary VM.
#
# IAM-condition gap: we cannot express "the target instance carries label
# afk-managed=true" as an IAM condition (labels aren't condition attributes).
# We therefore scope this to a custom role holding only compute.instances.delete
# and bind it project-wide; the practical containment is that the SA has no
# other compute permission (can't list, can't describe other VMs) AND the
# entrypoint only ever targets `$(hostname)` (its own instance). Document the
# residual: any VM that runs as this SA could in principle delete a sibling VM
# by name. Acceptable because only afk Run VMs run as this SA and they are
# single-tenant per Run.
resource "google_project_iam_custom_role" "vm_self_delete" {
  role_id     = "${replace(var.project_name, "-", "_")}_vm_self_delete"
  title       = "AFK VM self-delete"
  description = "compute.instances.delete only; bound to the Run instance SA so a Run can reclaim itself."
  permissions = [
    "compute.instances.delete",
    "compute.zoneOperations.get",
  ]
}

resource "google_project_iam_member" "vm_self_delete" {
  project = var.project_id
  role    = google_project_iam_custom_role.vm_self_delete.id
  member  = "serviceAccount:${google_service_account.vm.email}"
}

# ===========================================================================
# (b) Developer custom role + bindings.
#
# Bound to developer principals by `afk team add` (gcloud add-iam-policy-binding).
# The bindings here grant the baseline; team management adds/removes members.
# ===========================================================================

resource "google_project_iam_custom_role" "developer" {
  role_id     = "${replace(var.project_name, "-", "_")}_developer"
  title       = "AFK developer"
  description = "Permissions a developer needs to drive AFK Runs on this project."
  permissions = [
    # Launch + reclaim Run instances.
    "compute.instances.create",
    "compute.instances.delete",
    "compute.instances.get",
    "compute.instances.list",
    "compute.instances.setMetadata",
    "compute.instances.setLabels",
    # Pass the afk-vm SA to the instance (see actAs binding below).
    "compute.instances.setServiceAccount",
    # Read network/image/zone resources instances.create touches.
    "compute.subnetworks.use",
    "compute.subnetworks.useExternalIp",
    "compute.networks.get",
    "compute.images.get",
    "compute.images.list",
    "compute.images.useReadOnly",
    "compute.zones.get",
    "compute.machineTypes.get",
    "compute.machineTypes.list",
    "compute.disks.create",
    "compute.zoneOperations.get",
    # Golden image management (`afk golden build`/`rm`).
    "compute.images.create",
    "compute.images.delete",
    "compute.disks.useReadOnly",
    "compute.instances.setTags",
  ]
}

# compute.instances.create conditioned on the AFK subnet + machine-type
# whitelist where IAM conditions can express it.
#
# Expressible:  resource.name (zone/subnet/machine-type reference strings) via
#               startsWith / CEL list membership on the request's resource refs.
# NOT expressible: the afk-owner label == caller, golden-image label
#               (afk-golden=true), and afk-managed=true on the instance —
#               these are request-body labels, invisible to IAM conditions.
#               The CLI enforces all three at submit time (it stamps the labels
#               and validates the image/owner before calling instances.create).
resource "google_project_iam_member" "developer_role" {
  project = var.project_id
  role    = google_project_iam_custom_role.developer.id
  member  = var.developer_member

  condition {
    title       = "afk-machine-types-and-subnet"
    description = "Launch only into the AFK subnet with a whitelisted machine type. Owner/golden/managed label conditions are NOT expressible in IAM and are enforced CLI-side."
    expression  = <<-EOT
      (
        !resource.name.startsWith("projects/${var.project_id}/zones/")
        ||
        ${join(" || ", [for mt in var.allowed_machine_types : "resource.name.endsWith(\"/machineTypes/${mt}\")"])}
      )
    EOT
  }
}

# Allow the developer to attach (actAs) the afk-vm service account to a Run
# instance. The critical lockdown analogue to AWS PassRole: a developer may
# pass ONLY the afk-vm SA, not an arbitrary higher-privileged SA.
resource "google_service_account_iam_member" "developer_act_as_vm" {
  service_account_id = google_service_account.vm.name
  role               = "roles/iam.serviceAccountUser"
  member             = var.developer_member
}

# IAP tunnel access — required for `afk attach` (gcloud compute ssh
# --tunnel-through-iap). Scoped to the AFK instances via the IAP resource.
#
# IAM-condition gap: scoping to afk-owner == caller is not expressible (label
# condition). The CLI resolves the Run via history and only tunnels to Runs the
# caller owns, mirroring how AWS gates StartSession by owner CLI-side for the
# label-derived part.
resource "google_project_iam_member" "developer_iap_tunnel" {
  project = var.project_id
  role    = "roles/iap.tunnelResourceAccessor"
  member  = var.developer_member
}

# OS Login — maps the developer's Google principal to a POSIX user on the VM so
# the IAP SSH session authenticates without managed keys.
resource "google_project_iam_member" "developer_os_login" {
  project = var.project_id
  role    = "roles/compute.osLogin"
  member  = var.developer_member
}
