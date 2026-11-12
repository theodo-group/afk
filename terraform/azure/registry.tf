# Agent images built by `afk run` / `afk build`, one nested repository per
# consumer repo (`afk/<repo>`). Pulled by Run VMs with their managed identity.
resource "azurerm_container_registry" "afk" {
  name                = local.registry
  location            = azurerm_resource_group.afk.location
  resource_group_name = azurerm_resource_group.afk.name
  sku                 = "Standard"
  admin_enabled       = false
  tags                = local.tags
}

# Secrets dereferenced by `secret:<name>` entries in .afk.env, as
# `afk-secret-<name>`. RBAC-authorized: no access policies.
resource "azurerm_key_vault" "afk" {
  name                      = local.key_vault
  location                  = azurerm_resource_group.afk.location
  resource_group_name       = azurerm_resource_group.afk.name
  tenant_id                 = data.azurerm_client_config.current.tenant_id
  sku_name                  = "standard"
  enable_rbac_authorization = true
  purge_protection_enabled  = false
  tags                      = local.tags
}
