terraform {
  required_version = ">= 1.10"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 6.0"
    }
    null = {
      source  = "hashicorp/null"
      version = "~> 3.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.0"
    }
  }

  # Backend block is rendered into backend.tf by `afk init` (not declared here
  # to avoid a "duplicate backend configuration" error). GCS remote state.
}

provider "google" {
  project = var.project_id
  region  = var.region
  zone    = var.zone

  default_labels = merge(var.labels, {
    managed-by = "afk"
    project    = var.project_name
  })
}

provider "google-beta" {
  project = var.project_id
  region  = var.region
  zone    = var.zone

  default_labels = merge(var.labels, {
    managed-by = "afk"
    project    = var.project_name
  })
}

data "google_project" "current" {}

locals {
  project_id     = var.project_id
  project_number = data.google_project.current.number
  region         = var.region
  zone           = var.zone
}
