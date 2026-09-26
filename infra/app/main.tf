provider "google" {
  project = var.project_id
  region  = var.region
}
locals {
  runtime_roles = toset(["web", "worker"])
  services      = var.deploy_services ? local.runtime_roles : toset([])
  secret_grants = { for item in flatten([for role, entries in var.secret_versions : [for purpose in toset([for ref in values(entries) : ref.purpose]) : { role = role, purpose = purpose }]]) : "${item.role}/${item.purpose}" => item }
  common_env = {
    APP_ENV                      = "event", NODE_ENV = "production", RESOURCE_PREFIX = "realaddr-event",
    FIRESTORE_COLLECTION_PREFIX  = "realaddr_event_", FIRESTORE_DATABASE_ID = var.firestore_database_id,
    GCP_PROJECT_ID               = var.project_id, GCP_REGION = var.region,
    PRICE_PROFILE                = "testnet", PAYMENT_NETWORK = "eip155:84532",
    WORKER_URL                   = var.worker_url, TASKS_QUEUE = "realaddr-event-jobs",
    TASK_INVOKER_SA              = google_service_account.app["tasks"].email,
    SCHEDULER_INVOKER_SA         = google_service_account.app["sched"].email,
    CLOUD_TASKS_DISPATCH_ENABLED = tostring(var.dispatch_enabled)
  }
  service_env = { for role in local.runtime_roles : role => merge(local.common_env, role == "web" ? { PUBLIC_ORIGIN = "https://address.chain.tokyo", TERMS_VERSION = var.terms_version } : {}) }
}
resource "google_service_account" "app" {
  for_each     = toset(["web", "worker", "tasks", "sched"])
  project      = var.project_id
  account_id   = "realaddr-event-${each.key}"
  display_name = "RealAddr event ${each.key}"
}
resource "google_storage_bucket" "data" {
  project                     = var.project_id
  name                        = var.data_bucket_name
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  versioning { enabled = false }
  soft_delete_policy { retention_duration_seconds = 0 }
  lifecycle_rule {
    condition { age = 7 }
    action { type = "Delete" }
  }
  lifecycle { prevent_destroy = true }
}
resource "google_storage_bucket_iam_member" "worker" {
  bucket = google_storage_bucket.data.name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${google_service_account.app["worker"].email}"
}
resource "google_secret_manager_secret" "app" {
  for_each  = var.secret_purposes
  project   = var.project_id
  secret_id = "realaddr-event-${each.key}"
  replication {
    auto {}
  }
}
resource "google_secret_manager_secret_iam_member" "runtime" {
  for_each  = local.secret_grants
  project   = var.project_id
  secret_id = google_secret_manager_secret.app[each.value.purpose].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.app[each.value.role].email}"
}
resource "google_cloud_tasks_queue" "jobs" {
  project  = var.project_id
  location = var.region
  name     = "realaddr-event-jobs"
  rate_limits {
    max_dispatches_per_second = 1
    max_concurrent_dispatches = 1
  }
  retry_config {
    max_attempts       = 10
    min_backoff        = "5s"
    max_backoff        = "300s"
    max_doublings      = 3
    max_retry_duration = "3600s"
  }
}
resource "google_cloud_tasks_queue_iam_member" "enqueue" {
  for_each = local.runtime_roles
  project  = var.project_id
  location = var.region
  name     = google_cloud_tasks_queue.jobs.name
  role     = "roles/cloudtasks.enqueuer"
  member   = "serviceAccount:${google_service_account.app[each.key].email}"
}
resource "google_cloud_tasks_queue_iam_member" "worker_reconcile" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_tasks_queue.jobs.name
  role     = "roles/cloudtasks.viewer"
  member   = "serviceAccount:${google_service_account.app["worker"].email}"
}
resource "google_service_account_iam_member" "enqueue_act_as" {
  for_each           = local.runtime_roles
  service_account_id = google_service_account.app["tasks"].name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.app[each.key].email}"
}
resource "google_project_iam_member" "firestore" {
  for_each = var.firestore_access_reviewed && var.retain_legacy_default_access ? local.runtime_roles : toset([])
  project  = var.project_id
  role     = "roles/datastore.user"
  member   = "serviceAccount:${google_service_account.app[each.key].email}"
  condition {
    title      = "realaddr-event-default-database"
    expression = "resource.name == 'projects/${var.project_id}/databases/(default)'"
  }
}
resource "google_cloud_run_v2_service" "app" {
  for_each             = local.services
  project              = var.project_id
  location             = var.region
  name                 = "realaddr-event-${each.key}"
  deletion_protection  = true
  ingress              = "INGRESS_TRAFFIC_ALL"
  invoker_iam_disabled = each.key == "web" && var.web_public
  scaling {
    min_instance_count = 0
    max_instance_count = each.key == "web" ? 2 : 1
  }
  template {
    service_account                  = google_service_account.app[each.key].email
    timeout                          = "60s"
    max_instance_request_concurrency = each.key == "web" ? 20 : 1
    scaling {
      min_instance_count = 0
      max_instance_count = each.key == "web" ? 2 : 1
    }
    containers {
      image   = var.image_digest
      command = ["node"]
      args    = [each.key == "web" ? "apps/api/dist/index.js" : "apps/worker/dist/index.js"]
      resources {
        limits            = { cpu = "1", memory = "512Mi" }
        cpu_idle          = true
        startup_cpu_boost = false
      }
      dynamic "env" {
        for_each = nonsensitive(toset(keys(local.service_env[each.key])))
        content {
          name  = env.value
          value = local.service_env[each.key][env.value]
        }
      }
      dynamic "env" {
        for_each = lookup(var.secret_versions, each.key, {})
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.app[env.value.purpose].secret_id
              version = env.value.version
            }
          }
        }
      }
    }
  }
  lifecycle {
    ignore_changes = [template[0].containers[0].image]
    precondition {
      condition     = var.runtime_ready && var.firestore_access_reviewed && (var.firestore_database_id == "(default)" ? var.retain_legacy_default_access : var.firestore_database_ownership_reviewed && var.firestore_rules_reviewed) && var.image_digest != "" && var.worker_url != "" && var.terms_version != "" && contains(keys(lookup(var.secret_versions, "web", {})), "RATE_LIMIT_HMAC_KEY")
      error_message = "Services require reviewed runtime IAM/configuration, real secret versions, terms, worker origin and an image digest."
    }
  }
  depends_on = [google_secret_manager_secret_iam_member.runtime, google_project_iam_member.firestore, google_project_iam_member.firestore_realaddr, google_firestore_index.realaddr_outbox_due, google_firestore_index.realaddr_owner_lists]
}
resource "google_cloud_run_v2_service_iam_member" "worker_invoker" {
  for_each = var.deploy_services ? toset(["tasks", "sched"]) : toset([])
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.app["worker"].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.app[each.key].email}"
}
resource "google_cloud_run_v2_service_iam_member" "deploy" {
  for_each = local.services
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.app[each.key].name
  role     = "roles/run.developer"
  member   = "serviceAccount:${var.deploy_service_account}"
}
resource "google_service_account_iam_member" "deploy_act_as" {
  for_each           = local.runtime_roles
  service_account_id = google_service_account.app[each.key].name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${var.deploy_service_account}"
}
resource "google_cloud_scheduler_job" "sweep" {
  count            = var.deploy_services ? 1 : 0
  project          = var.project_id
  region           = var.region
  name             = "realaddr-event-sweep"
  schedule         = "*/5 * * * *"
  time_zone        = "Etc/UTC"
  paused           = !var.scheduler_enabled
  attempt_deadline = "60s"
  # Omitted retry settings use API defaults: zero retries and zero retry duration.
  http_target {
    http_method = "POST"
    uri         = "${var.worker_url}/scheduler/sweep"
    body        = base64encode("{}")
    headers     = { "Content-Type" = "application/json" }
    oidc_token {
      service_account_email = google_service_account.app["sched"].email
      audience              = var.worker_url
    }
  }
  lifecycle {
    precondition {
      condition     = !var.scheduler_enabled || var.dispatch_enabled
      error_message = "Enable Scheduler only after dispatch and runtime delivery have been verified."
    }
  }
  depends_on = [google_cloud_run_v2_service_iam_member.worker_invoker]
}

resource "google_cloud_run_domain_mapping" "web" {
  count           = var.deploy_services && var.web_public && var.domain_mapping_reviewed ? 1 : 0
  project         = var.project_id
  location        = var.region
  name            = "address.chain.tokyo"
  deletion_policy = "PREVENT"
  metadata {
    namespace = var.project_id
  }
  spec {
    route_name       = google_cloud_run_v2_service.app["web"].name
    certificate_mode = "AUTOMATIC"
    force_override   = false
  }
  lifecycle {
    prevent_destroy = true
  }
  depends_on = [google_cloud_run_v2_service.app]
}
