# One account for the run index (Table), Run logs and Session Artifacts (Blob),
# and the sweeper Function's own runtime storage.
resource "azurerm_storage_account" "afk" {
  name                            = local.storage_account
  location                        = azurerm_resource_group.afk.location
  resource_group_name             = azurerm_resource_group.afk.name
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  min_tls_version                 = "TLS1_2"
  allow_nested_items_to_be_public = false
  tags                            = local.tags
}

resource "azurerm_storage_container" "artifacts" {
  name                  = "afk-artifacts"
  storage_account_id    = azurerm_storage_account.afk.id
  container_access_type = "private"
}

resource "azurerm_storage_container" "logs" {
  name                  = "afk-logs"
  storage_account_id    = azurerm_storage_account.afk.id
  container_access_type = "private"
}

resource "azurerm_storage_table" "runs" {
  name                 = "afkruns"
  storage_account_name = azurerm_storage_account.afk.name
}

resource "azurerm_storage_management_policy" "afk" {
  storage_account_id = azurerm_storage_account.afk.id

  rule {
    name    = "expire-run-outputs"
    enabled = true
    filters {
      blob_types   = ["blockBlob"]
      prefix_match = ["afk-artifacts/", "afk-logs/"]
    }
    actions {
      base_blob {
        delete_after_days_since_modification_greater_than = var.artifact_retention_days
      }
    }
  }
}
