variable "project_id" {
  type      = string
  sensitive = true
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "Use the inventoried project ID from protected configuration."
  }
}

variable "region" {
  type = string
  validation {
    condition     = can(regex("^[a-z]+-[a-z]+[0-9]+$", var.region))
    error_message = "Use the explicitly verified region."
  }
}

variable "state_bucket_name" {
  type      = string
  sensitive = true
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$", var.state_bucket_name)) && (startswith(var.state_bucket_name, "realaddr-event-") || startswith(var.state_bucket_name, "${var.project_id}-realaddr-event-"))
    error_message = "Use a dedicated realaddr-event- bucket, optionally preceded by the supplied project ID."
  }
}

variable "artifact_repository_id" {
  type    = string
  default = "realaddr-event-images"
  validation {
    condition     = can(regex("^realaddr-event-[a-z0-9-]+$", var.artifact_repository_id))
    error_message = "Use a dedicated realaddr-event- repository ID."
  }
}

variable "wif_pool_id" {
  type    = string
  default = "realaddr-event-gh"
  validation {
    condition     = can(regex("^realaddr-event-[a-z0-9-]+$", var.wif_pool_id)) && length(var.wif_pool_id) <= 32
    error_message = "Use a dedicated realaddr-event- pool ID of at most 32 characters."
  }
}

variable "deploy_service_account" {
  type      = string
  sensitive = true
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\\.iam\\.gserviceaccount\\.com$", var.deploy_service_account))
    error_message = "Use the reviewed existing DEPLOY_SERVICE_ACCOUNT; default service accounts are not accepted."
  }
}

variable "github_repository" {
  type      = string
  sensitive = true
  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repository))
    error_message = "Use the reviewed owner/repository from protected configuration."
  }
}

variable "github_repository_id" {
  type      = string
  sensitive = true
  validation {
    condition     = can(regex("^[1-9][0-9]*$", var.github_repository_id))
    error_message = "Use the verified immutable repository ID."
  }
}

variable "github_owner_id" {
  type      = string
  sensitive = true
  validation {
    condition     = can(regex("^[1-9][0-9]*$", var.github_owner_id))
    error_message = "Use the verified immutable owner ID."
  }
}

variable "wif_enabled" {
  type    = bool
  default = false
}

variable "deploy_workflow_reviewed" {
  type    = bool
  default = false
}
