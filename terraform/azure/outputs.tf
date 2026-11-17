output "resource_group" {
  value = azurerm_resource_group.afk.name
}

output "location" {
  value = azurerm_resource_group.afk.location
}

output "storage_account" {
  value = azurerm_storage_account.afk.name
}

output "container_registry" {
  value = azurerm_container_registry.afk.login_server
}

output "key_vault" {
  value = azurerm_key_vault.afk.name
}

output "run_subnet_id" {
  value = azurerm_subnet.runs.id
}

output "run_identity_id" {
  value = azurerm_user_assigned_identity.vm.id
}

output "developer_role" {
  value = azurerm_role_definition.developer.name
}

output "sweeper_function" {
  value = azurerm_linux_function_app.sweeper.name
}
