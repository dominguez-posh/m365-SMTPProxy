# One-time base setup, run locally by the subscription owner (local state):
# - storage for the Terraform state of the server
# - managed identity for GitHub Actions with federated credentials (OIDC, no secret)
# Needs only Owner on the subscription, no rights in the Entra tenant.

terraform {
  required_version = ">= 1.6"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
  }
}

provider "azurerm" {
  features {}
  subscription_id = var.subscription_id
}

variable "subscription_id" {
  description = "Ziel-Subscription (nur lokal in terraform.tfvars, nicht committen)."
  type        = string
}

variable "location" {
  description = "Region des State-Speichers."
  type        = string
  default     = "westeurope"
}

variable "resource_group_name" {
  description = "Ressourcengruppe des State-Speichers (muss zu ../backend.hcl passen)."
  type        = string
  default     = "rg-smtpproxy-tfstate"
}

variable "storage_account_name" {
  description = "Storage Account für den State, weltweit eindeutig (muss zu ../backend.hcl passen)."
  type        = string
  default     = "stsmtpproxytfstate"
}

variable "github_subjects" {
  description = <<-EOT
    Subjects im GitHub-OIDC-Token für die Umgebung "prod". GitHub sendet je nach Repository
    "repo:<owner>/<repo>:environment:prod" oder das unveränderliche Format
    "repo:<owner>@<owner-id>/<repo>@<repo-id>:environment:prod"; beide sind hinterlegt.
    Bei Fehler AADSTS700213 steht der tatsächlich gesendete Subject in der Meldung.
  EOT
  type        = list(string)
  default = [
    "repo:dominguez-posh/m365-SMTPProxy:environment:prod",
    "repo:dominguez-posh@9081611/m365-SMTPProxy@1423692985:environment:prod",
  ]
}

data "azurerm_client_config" "current" {}
data "azurerm_subscription" "current" {}

resource "azurerm_resource_group" "state" {
  name     = var.resource_group_name
  location = var.location
  tags     = { workload = "smtpproxy", environment = "shared" }
}

resource "azurerm_storage_account" "state" {
  name                            = var.storage_account_name
  resource_group_name             = azurerm_resource_group.state.name
  location                        = azurerm_resource_group.state.location
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  min_tls_version                 = "TLS1_2"
  https_traffic_only_enabled      = true
  allow_nested_items_to_be_public = false
  tags                            = azurerm_resource_group.state.tags

  blob_properties {
    versioning_enabled = true
    delete_retention_policy {
      days = 14
    }
    container_delete_retention_policy {
      days = 14
    }
  }
}

resource "azurerm_storage_container" "state" {
  name                  = "tfstate"
  storage_account_id    = azurerm_storage_account.state.id
  container_access_type = "private"
}

# state access via Entra ID for the signed-in person (local runs)
resource "azurerm_role_assignment" "state_current_user" {
  scope                = azurerm_storage_account.state.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = data.azurerm_client_config.current.object_id
}

# ------------------------------------------------------------ GitHub Actions

resource "azurerm_user_assigned_identity" "github" {
  name                = "id-smtpproxy-github"
  resource_group_name = azurerm_resource_group.state.name
  location            = azurerm_resource_group.state.location
  tags                = azurerm_resource_group.state.tags
}

resource "azurerm_federated_identity_credential" "github" {
  for_each                  = { for i, s in var.github_subjects : tostring(i) => s }
  name                      = "github-prod-${each.key}"
  user_assigned_identity_id = azurerm_user_assigned_identity.github.id
  audience                  = ["api://AzureADTokenExchange"]
  issuer                    = "https://token.actions.githubusercontent.com"
  subject                   = each.value
}

# creates the resource group and resources of the server
resource "azurerm_role_assignment" "github_contributor" {
  scope                = data.azurerm_subscription.current.id
  role_definition_name = "Contributor"
  principal_id         = azurerm_user_assigned_identity.github.principal_id
  principal_type       = "ServicePrincipal"
}

resource "azurerm_role_assignment" "github_state" {
  scope                = azurerm_storage_account.state.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_user_assigned_identity.github.principal_id
  principal_type       = "ServicePrincipal"
}

output "github_secrets" {
  description = "Als Repository-Secrets in GitHub hinterlegen (Settings > Secrets and variables > Actions)."
  value = {
    AZURE_CLIENT_ID       = azurerm_user_assigned_identity.github.client_id
    AZURE_TENANT_ID       = data.azurerm_client_config.current.tenant_id
    AZURE_SUBSCRIPTION_ID = data.azurerm_client_config.current.subscription_id
  }
}
