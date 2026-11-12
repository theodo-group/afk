terraform {
  required_version = ">= 1.10"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
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
  # to avoid a "duplicate backend configuration" error). azurerm remote state,
  # in a storage account of its own resource group (`<resource_group>-tfstate`).
}

provider "azurerm" {
  subscription_id = var.subscription_id

  features {
    key_vault {
      # `afk destroy` is meant to leave nothing behind; a soft-deleted vault
      # would also squat its globally unique name for 90 days.
      purge_soft_delete_on_destroy = true
    }
    resource_group {
      # Run VMs and Golden images live in the group but outside this state.
      prevent_deletion_if_contains_resources = false
    }
  }
}

data "azurerm_client_config" "current" {}

locals {
  # Must stay identical to the CLI's `azureNameSuffix` (adapters/azure/AzureNames.ts):
  # the CLI derives every global name below from the same hash instead of
  # reading Terraform outputs.
  suffix = substr(sha256(lower("${var.subscription_id}/${var.resource_group}")), 0, 12)

  storage_account = "afk${local.suffix}"
  registry        = "afk${local.suffix}"
  key_vault       = "afk-${local.suffix}"
  developer_role  = "afk-developer-${local.suffix}"

  tags = merge(var.tags, {
    managed-by = "afk"
    project    = var.project_name
  })
}

resource "azurerm_resource_group" "afk" {
  name     = var.resource_group
  location = var.location
  tags     = local.tags
}
