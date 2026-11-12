# ---------------------------------------------------------------------------
# Identities and roles, all scoped to the afk resource group or narrower.
# ---------------------------------------------------------------------------

# --- The identity every Run VM (and the golden builder) runs as ---

resource "azurerm_user_assigned_identity" "vm" {
  name                = "afk-vm"
  location            = azurerm_resource_group.afk.location
  resource_group_name = azurerm_resource_group.afk.name
  tags                = local.tags
}

resource "azurerm_role_assignment" "vm_acr_pull" {
  scope                = azurerm_container_registry.afk.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.vm.principal_id
  principal_type       = "ServicePrincipal"
}

resource "azurerm_role_assignment" "vm_secrets" {
  scope                = azurerm_key_vault.afk.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.vm.principal_id
  principal_type       = "ServicePrincipal"
}

# Logs and Session Artifacts out, completion row into the run index.
resource "azurerm_role_assignment" "vm_blobs" {
  scope                = azurerm_storage_account.afk.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_user_assigned_identity.vm.principal_id
  principal_type       = "ServicePrincipal"
}

resource "azurerm_role_assignment" "vm_table" {
  scope                = azurerm_storage_account.afk.id
  role_definition_name = "Storage Table Data Contributor"
  principal_id         = azurerm_user_assigned_identity.vm.principal_id
  principal_type       = "ServicePrincipal"
}

# Self-reclaim: a Run deletes (or, retained, tags and deallocates) its own VM;
# the NIC and OS disk go with it through their delete options. Group-wide,
# because Azure RBAC cannot say "only the VM calling" — the same trade-off the
# GCP Backend documents for its instance service account.
resource "azurerm_role_definition" "vm_self_reclaim" {
  name        = "afk-self-reclaim-${local.suffix}"
  scope       = azurerm_resource_group.afk.id
  description = "Lets an afk Run VM delete or deallocate itself."

  permissions {
    actions = [
      "Microsoft.Compute/virtualMachines/read",
      "Microsoft.Compute/virtualMachines/write",
      "Microsoft.Compute/virtualMachines/delete",
      "Microsoft.Compute/virtualMachines/deallocate/action",
      "Microsoft.Compute/disks/read",
      "Microsoft.Compute/disks/delete",
      "Microsoft.Network/networkInterfaces/read",
      "Microsoft.Network/networkInterfaces/delete",
      "Microsoft.Resources/tags/write",
    ]
  }

  assignable_scopes = [azurerm_resource_group.afk.id]
}

resource "azurerm_role_assignment" "vm_self_reclaim" {
  scope              = azurerm_resource_group.afk.id
  role_definition_id = azurerm_role_definition.vm_self_reclaim.role_definition_resource_id
  principal_id       = azurerm_user_assigned_identity.vm.principal_id
  principal_type     = "ServicePrincipal"
}

# --- The developer role: everything `afk` does on a developer's behalf ---
#
# The CLI addresses it by name (`afk-developer-<suffix>`) for `afk team`.
# VM size and image limits are enforced CLI-side (allowedVmSizes), as on GCP:
# Azure RBAC conditions cannot read a VM's requested size.
resource "azurerm_role_definition" "developer" {
  name        = local.developer_role
  scope       = azurerm_resource_group.afk.id
  description = "Launch, inspect, attach to and reclaim afk Runs; build Golden images; manage afk secrets."

  permissions {
    actions = [
      "*/read",
      # `az vm create` submits an ARM deployment.
      "Microsoft.Resources/deployments/*",
      "Microsoft.Compute/virtualMachines/*",
      "Microsoft.Compute/images/*",
      "Microsoft.Compute/disks/*",
      "Microsoft.Network/networkInterfaces/*",
      "Microsoft.Network/virtualNetworks/subnets/join/action",
      "Microsoft.Network/networkSecurityGroups/join/action",
      "Microsoft.ManagedIdentity/userAssignedIdentities/assign/action",
      "Microsoft.ContainerRegistry/registries/pull/read",
      "Microsoft.ContainerRegistry/registries/push/write",
      "Microsoft.Resources/tags/write",
    ]
    data_actions = [
      "Microsoft.KeyVault/vaults/secrets/*",
      "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read",
      "Microsoft.Storage/storageAccounts/tableServices/tables/entities/*",
    ]
  }

  assignable_scopes = [azurerm_resource_group.afk.id]
}

resource "azurerm_role_assignment" "developer" {
  count              = var.developer_object_id == "" ? 0 : 1
  scope              = azurerm_resource_group.afk.id
  role_definition_id = azurerm_role_definition.developer.role_definition_resource_id
  principal_id       = var.developer_object_id
  principal_type     = var.developer_principal_type
}

# Entra ID SSH sign-in with sudo — `afk attach` runs `sudo docker` on the VM.
resource "azurerm_role_assignment" "developer_vm_login" {
  count                = var.developer_object_id == "" ? 0 : 1
  scope                = azurerm_resource_group.afk.id
  role_definition_name = "Virtual Machine Administrator Login"
  principal_id         = var.developer_object_id
  principal_type       = var.developer_principal_type
}
