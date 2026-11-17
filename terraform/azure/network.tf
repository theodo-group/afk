# ---------------------------------------------------------------------------
# Network: one VNet, a private Run subnet with outbound through a NAT gateway
# (no public IPs, no default outbound access), and Azure Bastion — the IAP
# analogue `afk attach` tunnels through.
# ---------------------------------------------------------------------------

resource "azurerm_virtual_network" "afk" {
  name                = "afk-vnet"
  location            = azurerm_resource_group.afk.location
  resource_group_name = azurerm_resource_group.afk.name
  address_space       = [var.vnet_cidr]
  tags                = local.tags
}

resource "azurerm_subnet" "runs" {
  name                            = "afk-subnet"
  resource_group_name             = azurerm_resource_group.afk.name
  virtual_network_name            = azurerm_virtual_network.afk.name
  address_prefixes                = [var.subnet_cidr]
  default_outbound_access_enabled = false
}

# Inbound from the Internet is denied by the default rules; inside the VNet
# only Bastion may open SSH to a Run.
resource "azurerm_network_security_group" "runs" {
  name                = "afk-runs-nsg"
  location            = azurerm_resource_group.afk.location
  resource_group_name = azurerm_resource_group.afk.name
  tags                = local.tags

  security_rule {
    name                       = "allow-ssh-from-bastion"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "22"
    source_address_prefix      = var.bastion_subnet_cidr
    destination_address_prefix = "*"
  }

  security_rule {
    name                       = "deny-other-vnet-inbound"
    priority                   = 200
    direction                  = "Inbound"
    access                     = "Deny"
    protocol                   = "*"
    source_port_range          = "*"
    destination_port_range     = "*"
    source_address_prefix      = "VirtualNetwork"
    destination_address_prefix = "*"
  }
}

resource "azurerm_subnet_network_security_group_association" "runs" {
  subnet_id                 = azurerm_subnet.runs.id
  network_security_group_id = azurerm_network_security_group.runs.id
}

resource "azurerm_public_ip" "nat" {
  name                = "afk-nat-ip"
  location            = azurerm_resource_group.afk.location
  resource_group_name = azurerm_resource_group.afk.name
  allocation_method   = "Static"
  sku                 = "Standard"
  tags                = local.tags
}

resource "azurerm_nat_gateway" "afk" {
  name                = "afk-nat"
  location            = azurerm_resource_group.afk.location
  resource_group_name = azurerm_resource_group.afk.name
  sku_name            = "Standard"
  tags                = local.tags
}

resource "azurerm_nat_gateway_public_ip_association" "afk" {
  nat_gateway_id       = azurerm_nat_gateway.afk.id
  public_ip_address_id = azurerm_public_ip.nat.id
}

resource "azurerm_subnet_nat_gateway_association" "runs" {
  subnet_id      = azurerm_subnet.runs.id
  nat_gateway_id = azurerm_nat_gateway.afk.id
}

# --- Bastion (Standard SKU: native-client tunnelling for `az network bastion ssh`) ---

resource "azurerm_subnet" "bastion" {
  count                = var.bastion_enabled ? 1 : 0
  name                 = "AzureBastionSubnet"
  resource_group_name  = azurerm_resource_group.afk.name
  virtual_network_name = azurerm_virtual_network.afk.name
  address_prefixes     = [var.bastion_subnet_cidr]
}

resource "azurerm_public_ip" "bastion" {
  count               = var.bastion_enabled ? 1 : 0
  name                = "afk-bastion-ip"
  location            = azurerm_resource_group.afk.location
  resource_group_name = azurerm_resource_group.afk.name
  allocation_method   = "Static"
  sku                 = "Standard"
  tags                = local.tags
}

resource "azurerm_bastion_host" "afk" {
  count               = var.bastion_enabled ? 1 : 0
  name                = "afk-bastion"
  location            = azurerm_resource_group.afk.location
  resource_group_name = azurerm_resource_group.afk.name
  sku                 = "Standard"
  tunneling_enabled   = true
  tags                = local.tags

  ip_configuration {
    name                 = "afk-bastion"
    subnet_id            = azurerm_subnet.bastion[0].id
    public_ip_address_id = azurerm_public_ip.bastion[0].id
  }
}
