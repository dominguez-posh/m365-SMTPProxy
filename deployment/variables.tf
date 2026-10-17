variable "subscription_id" {
  description = "Ziel-Subscription. Nicht committen: lokal in subscription.auto.tfvars, in der Pipeline über ARM_SUBSCRIPTION_ID."
  type        = string
  default     = null
}

variable "location" {
  description = "Azure-Region."
  type        = string
  default     = "westeurope"
}

variable "resource_group_name" {
  description = "Ressourcengruppe des Servers (wird angelegt)."
  type        = string
  default     = "rg-smtpproxy"
}

variable "name" {
  description = "Basisname: Container App, Umgebung, Log Analytics, Storage. Daraus entsteht auch die Adresse <name>.<zufall>.<region>.azurecontainerapps.io."
  type        = string
  default     = "smtpproxy"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,30}[a-z0-9]$", var.name))
    error_message = "name: 3 bis 32 Zeichen, Kleinbuchstaben, Ziffern und Bindestriche, beginnt mit einem Buchstaben."
  }
}

variable "tags" {
  description = "Zusätzliche Tags für alle Ressourcen."
  type        = map(string)
  default     = {}
}

variable "image_repository" {
  description = "Container-Image des Servers ohne Tag."
  type        = string
  default     = "ghcr.io/dominguez-posh/m365-smtpproxy"
}

variable "image_tag" {
  description = "Image-Tag (Commit-SHA), kommt von der Pipeline. Nicht in tfvars eintragen."
  type        = string
  default     = null
}

variable "cpu" {
  description = "vCPU des Servers (0.25, 0.5, 0.75 oder 1)."
  type        = number
  default     = 0.25
}

variable "memory" {
  description = "Arbeitsspeicher passend zur vCPU (0.25 -> 0.5Gi, 0.5 -> 1Gi, 0.75 -> 1.5Gi, 1 -> 2Gi)."
  type        = string
  default     = "0.5Gi"
}

variable "min_replicas" {
  description = "0 = schläft ohne Anfragen (verbundene Proxys halten ihn wach); 1 = läuft immer. Höchstens eine Instanz."
  type        = number
  default     = 0

  validation {
    condition     = contains([0, 1], var.min_replicas)
    error_message = "min_replicas muss 0 oder 1 sein (der Server unterstützt nur eine Instanz)."
  }
}

variable "idle_minutes" {
  description = "Abmeldung im Browser nach Inaktivität in Minuten."
  type        = number
  default     = 30
}

variable "data_share_quota_gb" {
  description = "Größe der Dateifreigabe für das Datenverzeichnis in GB."
  type        = number
  default     = 5
}

variable "log_daily_quota_gb" {
  description = "Tageslimit der Container-Protokolle in GB (Kostenbremse)."
  type        = number
  default     = 0.2
}
