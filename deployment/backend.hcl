# State storage created by bootstrap/.
resource_group_name  = "rg-smtpproxy-tfstate"
storage_account_name = "stsmtpproxytfstate"
container_name       = "tfstate"
key                  = "prod.tfstate"
use_azuread_auth     = true
