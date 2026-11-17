# ---------------------------------------------------------------------------
# Sweeper Azure Function (Node, timer-triggered).
#
# Code lives in function/sweeper/, bundled with esbuild at `terraform apply`
# time (mirrors terraform/gcp/function/sweeper). Three duties: reclaim live
# Runs that overran their timeout by more than the grace (the crash backstop —
# Azure has no native max-run-duration; the VM's own systemd timer fires
# first), reap retained Runs past the retention window, and flip orphaned
# "running" rows in the run index whose VM no longer exists.
# ---------------------------------------------------------------------------

locals {
  sweeper_src_dir = "${path.module}/function/sweeper"
  sweeper_dist    = "${path.module}/function/sweeper/dist"
}

resource "null_resource" "sweeper_build" {
  triggers = {
    source = filesha256("${local.sweeper_src_dir}/index.ts")
    pkg    = filesha256("${local.sweeper_src_dir}/package.json")
    host   = filesha256("${local.sweeper_src_dir}/host.json")
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

resource "azurerm_service_plan" "sweeper" {
  name                = "afk-sweeper-plan"
  location            = azurerm_resource_group.afk.location
  resource_group_name = azurerm_resource_group.afk.name
  os_type             = "Linux"
  sku_name            = "Y1"
  tags                = local.tags
}

resource "azurerm_linux_function_app" "sweeper" {
  name                       = "afk-sweeper-${local.suffix}"
  location                   = azurerm_resource_group.afk.location
  resource_group_name        = azurerm_resource_group.afk.name
  service_plan_id            = azurerm_service_plan.sweeper.id
  storage_account_name       = azurerm_storage_account.afk.name
  storage_account_access_key = azurerm_storage_account.afk.primary_access_key
  zip_deploy_file            = data.archive_file.sweeper.output_path
  https_only                 = true
  tags                       = local.tags

  identity {
    type = "SystemAssigned"
  }

  site_config {
    application_stack {
      node_version = "22"
    }
  }

  app_settings = {
    WEBSITE_RUN_FROM_PACKAGE = "1"
    AFK_SUBSCRIPTION_ID      = var.subscription_id
    AFK_RESOURCE_GROUP       = azurerm_resource_group.afk.name
    AFK_STORAGE_ACCOUNT      = azurerm_storage_account.afk.name
    AFK_RUNS_TABLE           = azurerm_storage_table.runs.name
    AFK_SWEEPER_SCHEDULE     = var.sweeper_schedule
    RETENTION_DAYS           = tostring(var.retention_days)
    BACKSTOP_GRACE_MINUTES   = tostring(var.backstop_grace_minutes)
  }
}

# List, delete and deallocate VMs in the group — and nothing else. Like the
# GCP sweeper, it only ever targets afk-managed VMs, enforced in code.
resource "azurerm_role_definition" "sweeper" {
  name        = "afk-sweeper-${local.suffix}"
  scope       = azurerm_resource_group.afk.id
  description = "List afk Run VMs; reclaim overrun and expired retained ones."

  permissions {
    actions = [
      "Microsoft.Compute/virtualMachines/read",
      "Microsoft.Compute/virtualMachines/write",
      "Microsoft.Compute/virtualMachines/delete",
      "Microsoft.Compute/virtualMachines/deallocate/action",
      "Microsoft.Compute/disks/delete",
      "Microsoft.Network/networkInterfaces/delete",
    ]
  }

  assignable_scopes = [azurerm_resource_group.afk.id]
}

resource "azurerm_role_assignment" "sweeper_vms" {
  scope              = azurerm_resource_group.afk.id
  role_definition_id = azurerm_role_definition.sweeper.role_definition_resource_id
  principal_id       = azurerm_linux_function_app.sweeper.identity[0].principal_id
  principal_type     = "ServicePrincipal"
}

resource "azurerm_role_assignment" "sweeper_table" {
  scope                = azurerm_storage_account.afk.id
  role_definition_name = "Storage Table Data Contributor"
  principal_id         = azurerm_linux_function_app.sweeper.identity[0].principal_id
  principal_type       = "ServicePrincipal"
}
