variable "subscription_id" {
  description = "Azure subscription hosting all AFK resources."
  type        = string
}

variable "location" {
  description = "Azure location (region) of the resource group, its network and every Run VM."
  type        = string
  default     = "westeurope"
}

variable "resource_group" {
  description = "Resource group holding every AFK resource. Must match `azure.resourceGroup` in afk.config.json — the CLI derives the global resource names from it."
  type        = string
  default     = "afk"
}

variable "developer_object_id" {
  description = "Microsoft Entra object id granted the afk-developer role and VM sign-in (set by `afk provision` from the signed-in az principal). Empty grants nobody; `afk team add` adds members at runtime."
  type        = string
  default     = ""
}

variable "developer_principal_type" {
  description = "Principal type of developer_object_id: User, Group or ServicePrincipal."
  type        = string
  default     = "User"
}

variable "retention_days" {
  description = "Days a retained Run's deallocated VM is kept (resumable via `afk attach`) before the sweeper reclaims it. Should match the CLI's retentionDays."
  type        = number
  default     = 7
}

variable "backstop_grace_minutes" {
  description = "Minutes past a Run's timeout before the sweeper reclaims a VM that is still up. Must exceed the in-VM backstop's grace (10 min) so the VM's own timer gets the first go."
  type        = number
  default     = 30
}

variable "project_name" {
  description = "Surfaces in resource tags."
  type        = string
  default     = "afk"
}

variable "vnet_cidr" {
  description = "Address space of the AFK virtual network."
  type        = string
  default     = "10.50.0.0/16"
}

variable "subnet_cidr" {
  description = "Subnet Run VMs draw private IPs from; they get no public IP and reach out through the NAT gateway."
  type        = string
  default     = "10.50.0.0/20"
}

variable "bastion_subnet_cidr" {
  description = "AzureBastionSubnet range (at least /26)."
  type        = string
  default     = "10.50.16.0/26"
}

variable "bastion_enabled" {
  description = "Deploy Azure Bastion (Standard SKU, native-client tunnelling), which `afk attach` rides. Bastion bills hourly; disable it if nobody attaches."
  type        = bool
  default     = true
}

variable "artifact_retention_days" {
  description = "Days to keep Session Artifacts and Run logs in Blob storage before lifecycle expiry."
  type        = number
  default     = 30
}

variable "sweeper_schedule" {
  description = "NCRONTAB (six fields, seconds first) for the sweeper Function's timer."
  type        = string
  default     = "0 */5 * * * *"
}

variable "tags" {
  description = "Extra tags applied to every AFK-managed resource."
  type        = map(string)
  default     = {}
}
