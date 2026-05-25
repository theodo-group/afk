# ---------------------------------------------------------------------------
# Network for AFK Run instances.
#
# Run VMs get NO external IP (attach is via IAP TCP tunnel, not inbound SSH on
# a public address). The only ingress permitted is SSH (tcp:22) from IAP's
# fixed source range 35.235.240.0/20. Egress (image pulls from Artifact
# Registry / Docker Hub, GitHub clone, the gcloud self-delete call) goes
# through Cloud NAT since there is no external IP.
# ---------------------------------------------------------------------------

resource "google_compute_network" "afk" {
  name                    = "${var.project_name}-vpc"
  auto_create_subnetworks = false

  depends_on = [google_project_service.required]
}

resource "google_compute_subnetwork" "afk" {
  name          = "${var.project_name}-subnet"
  network       = google_compute_network.afk.id
  region        = var.region
  ip_cidr_range = var.subnet_cidr

  # Required for IAP tunnelling and for VMs without an external IP to reach
  # Google APIs (logging, secret manager, artifact registry) privately.
  private_ip_google_access = true
}

# Allow IAP's published source range to reach SSH on Run VMs. IAP terminates
# the developer's authenticated tunnel and forwards from this range only.
resource "google_compute_firewall" "iap_ssh" {
  name      = "${var.project_name}-allow-iap-ssh"
  network   = google_compute_network.afk.id
  direction = "INGRESS"

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }

  # IAP's fixed forwarding range. Nothing else may reach :22.
  source_ranges = ["35.235.240.0/20"]
  target_tags   = ["${var.project_name}-run"]
}

# Deny all other inbound to Run VMs explicitly (belt-and-braces; the default
# VPC ingress is already deny, but make the posture legible).
resource "google_compute_firewall" "deny_ingress" {
  name      = "${var.project_name}-deny-ingress"
  network   = google_compute_network.afk.id
  direction = "INGRESS"
  priority  = 65534

  deny {
    protocol = "all"
  }

  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["${var.project_name}-run"]
}

# --- Cloud NAT: egress for VMs that have no external IP ---

resource "google_compute_router" "afk" {
  name    = "${var.project_name}-router"
  network = google_compute_network.afk.id
  region  = var.region
}

resource "google_compute_router_nat" "afk" {
  name                               = "${var.project_name}-nat"
  router                             = google_compute_router.afk.name
  region                             = var.region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"

  log_config {
    enable = false
    filter = "ERRORS_ONLY"
  }
}
