variable "project_id" {
  type      = string
  sensitive = true
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "Supply the inventoried project ID from protected configuration."
  }
}
variable "region" {
  type = string
  validation {
    condition     = can(regex("^[a-z]+-[a-z]+[0-9]+$", var.region))
    error_message = "Supply the region reviewed against shared database placement."
  }
}
variable "data_bucket_name" {
  type      = string
  sensitive = true
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$", var.data_bucket_name)) && (startswith(var.data_bucket_name, "realaddr-event-") || startswith(var.data_bucket_name, "${var.project_id}-realaddr-event-"))
    error_message = "Use an inventoried dedicated realaddr-event bucket."
  }
}
variable "deploy_service_account" {
  type      = string
  sensitive = true
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]@${var.project_id}\\.iam\\.gserviceaccount\\.com$", var.deploy_service_account))
    error_message = "Supply the reviewed existing DEPLOY_SERVICE_ACCOUNT; no default account fallback."
  }
}
variable "deploy_services" {
  type    = bool
  default = false
}
variable "image_digest" {
  type      = string
  default   = ""
  sensitive = true
  validation {
    condition     = var.image_digest == "" || can(regex("^[^[:space:]]+@sha256:[a-f0-9]{64}$", var.image_digest))
    error_message = "Use the same reviewed immutable image digest for both services."
  }
}
variable "worker_url" {
  type      = string
  default   = ""
  sensitive = true
  validation {
    condition     = var.worker_url == "" || can(regex("^https://[a-z0-9.-]+$", var.worker_url))
    error_message = "Supply the verified worker HTTPS origin without a path."
  }
}
variable "terms_version" {
  type    = string
  default = ""
}
variable "runtime_ready" {
  type    = bool
  default = false
}
variable "web_public" {
  type    = bool
  default = false
}
variable "scheduler_enabled" {
  type    = bool
  default = false
}
variable "dispatch_enabled" {
  type    = bool
  default = false
}
variable "firestore_access_reviewed" {
  type    = bool
  default = false
}
variable "secret_purposes" {
  type    = set(string)
  default = []
  validation {
    condition     = alltrue([for purpose in var.secret_purposes : can(regex("^[a-z][a-z0-9-]+$", purpose))])
    error_message = "Use lowercase secret purposes; supply metadata only."
  }
}
variable "secret_versions" {
  type    = map(map(object({ purpose = string, version = string })))
  default = { web = {}, worker = {} }
  validation {
    condition     = alltrue([for role, entries in var.secret_versions : contains(["web", "worker"], role) && alltrue([for key, ref in entries : can(regex("^[A-Z][A-Z0-9_]+$", key)) && !contains(["APP_ENV", "NODE_ENV", "RESOURCE_PREFIX", "FIRESTORE_COLLECTION_PREFIX", "FIRESTORE_DATABASE_ID", "FIRESTORE_EMULATOR_HOST", "GCP_PROJECT_ID", "GCP_REGION", "PRICE_PROFILE", "PAYMENT_NETWORK", "WORKER_URL", "TASKS_QUEUE", "TASK_INVOKER_SA", "SCHEDULER_INVOKER_SA", "CLOUD_TASKS_DISPATCH_ENABLED", "PUBLIC_ORIGIN", "TERMS_VERSION", "PORT", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CREDENTIALS", "GOOGLE_CLOUD_KEYFILE_JSON", "GCLOUD_KEYFILE_JSON"], key) && contains(var.secret_purposes, ref.purpose) && can(regex("^[1-9][0-9]*$", ref.version))])])
    error_message = "Reference declared secret metadata and an existing numeric version for web/worker only; fixed runtime controls and credential files cannot be injected."
  }
}
