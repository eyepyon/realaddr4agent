mock_provider "google" {}
override_resource {
  target          = google_service_account.app["worker"]
  override_during = plan
  values = {
    email = "realaddr-event-worker@demo-realaddr-local.iam.gserviceaccount.com"
    name  = "projects/demo-realaddr-local/serviceAccounts/realaddr-event-worker@demo-realaddr-local.iam.gserviceaccount.com"
  }
}
variables {
  project_id             = "demo-realaddr-local"
  region                 = "us-central1"
  data_bucket_name       = "realaddr-event-test-data"
  deploy_service_account = "realaddr-event-test@demo-realaddr-local.iam.gserviceaccount.com"
}
run "foundation_closed" {
  command = plan
  assert {
    condition     = length(google_service_account.app) == 4 && length(google_cloud_run_v2_service.app) == 0 && length(google_cloud_scheduler_job.sweep) == 0 && length(google_project_iam_member.firestore) == 0 && length(google_cloud_run_domain_mapping.web) == 0 && !var.dispatch_enabled
    error_message = "Foundation must not start runtime, grant shared DB access or expose a service."
  }
  assert {
    condition     = google_storage_bucket.data.uniform_bucket_level_access && google_storage_bucket.data.public_access_prevention == "enforced" && !google_storage_bucket.data.force_destroy && !google_storage_bucket.data.versioning[0].enabled && google_storage_bucket.data.soft_delete_policy[0].retention_duration_seconds == 0 && one(one(google_storage_bucket.data.lifecycle_rule).condition).age == 7
    error_message = "Business storage must be private with short retention and no soft delete/versioning."
  }
  assert {
    condition     = google_cloud_tasks_queue.jobs.rate_limits[0].max_dispatches_per_second == 1 && google_cloud_tasks_queue.jobs.rate_limits[0].max_concurrent_dispatches == 1 && google_cloud_tasks_queue.jobs.retry_config[0].max_attempts == 10
    error_message = "Queue must retain bounded delivery and retries."
  }
  assert {
    condition     = google_cloud_tasks_queue_iam_member.worker_reconcile.role == "roles/cloudtasks.viewer" && google_cloud_tasks_queue_iam_member.worker_reconcile.name == "realaddr-event-jobs" && google_cloud_tasks_queue_iam_member.worker_reconcile.member == "serviceAccount:realaddr-event-worker@demo-realaddr-local.iam.gserviceaccount.com" && alltrue([for grant in values(google_cloud_tasks_queue_iam_member.enqueue) : grant.role == "roles/cloudtasks.enqueuer"])
    error_message = "Task reconciliation read access belongs only to the worker on this queue; preserve enqueue roles."
  }
}
run "reviewed_services_private" {
  command = plan
  variables {
    deploy_services           = true
    runtime_ready             = true
    firestore_access_reviewed = true
    image_digest              = "registry.example.invalid/app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    worker_url                = "https://worker.example.invalid"
    terms_version             = "test-terms"
    secret_purposes           = ["rate-limit-hmac"]
    secret_versions           = { web = { RATE_LIMIT_HMAC_KEY = { purpose = "rate-limit-hmac", version = "1" } }, worker = {} }
  }
  assert {
    condition     = length(google_cloud_scheduler_job.sweep[0].retry_config) == 0
    error_message = "Scheduler must retain the API default of no retry attempts or retry duration without an empty settings block."
  }
  assert {
    condition     = google_cloud_run_v2_service.app["web"].scaling[0].min_instance_count == 0 && google_cloud_run_v2_service.app["web"].scaling[0].max_instance_count == 2 && google_cloud_run_v2_service.app["web"].template[0].max_instance_request_concurrency == 20 && google_cloud_run_v2_service.app["worker"].scaling[0].max_instance_count == 1 && google_cloud_run_v2_service.app["worker"].template[0].max_instance_request_concurrency == 1 && google_cloud_run_v2_service.app["worker"].template[0].containers[0].resources[0].cpu_idle && google_cloud_run_v2_service.app["worker"].template[0].timeout == "60s"
    error_message = "Services must keep scale-to-zero and bounded request-based compute."
  }
  assert {
    condition     = !google_cloud_run_v2_service.app["web"].invoker_iam_disabled && !google_cloud_run_v2_service.app["worker"].invoker_iam_disabled && length(google_cloud_run_domain_mapping.web) == 0 && google_cloud_scheduler_job.sweep[0].paused && length(google_cloud_run_v2_service_iam_member.worker_invoker) == 2 && alltrue([for item in values(google_cloud_run_v2_service_iam_member.worker_invoker) : item.role == "roles/run.invoker" && item.member != "allUsers"]) && google_project_iam_member.firestore["web"].condition[0].expression == "resource.name == 'projects/demo-realaddr-local/databases/(default)'"
    error_message = "Default closed IAM/Scheduler and database-scoped additive grants must remain."
  }
}
run "reject_unready_runtime" {
  command = plan
  variables { deploy_services = true }
  expect_failures = [google_cloud_run_v2_service.app]
}

run "public_mapping_requires_review" {
  command = plan
  variables {
    web_public                = true
    domain_mapping_reviewed   = false
    deploy_services           = true
    runtime_ready             = true
    firestore_access_reviewed = true
    image_digest              = "registry.example.invalid/app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    worker_url                = "https://worker.example.invalid"
    terms_version             = "test-terms"
    secret_purposes           = ["rate-limit-hmac"]
    secret_versions           = { web = { RATE_LIMIT_HMAC_KEY = { purpose = "rate-limit-hmac", version = "1" } }, worker = {} }
  }

  assert {
    condition     = google_cloud_run_v2_service.app["web"].invoker_iam_disabled && !google_cloud_run_v2_service.app["worker"].invoker_iam_disabled && length(google_cloud_run_domain_mapping.web) == 0
    error_message = "Domain mapping requires explicit review and must preserve dedicated target and deletion protection."
  }
}

run "reviewed_public_mapping" {
  command = plan
  variables {
    web_public                = true
    domain_mapping_reviewed   = true
    deploy_services           = true
    runtime_ready             = true
    firestore_access_reviewed = true
    image_digest              = "registry.example.invalid/app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    worker_url                = "https://worker.example.invalid"
    terms_version             = "test-terms"
    secret_purposes           = ["rate-limit-hmac"]
    secret_versions           = { web = { RATE_LIMIT_HMAC_KEY = { purpose = "rate-limit-hmac", version = "1" } }, worker = {} }
  }

  assert {
    condition     = google_cloud_run_v2_service.app["web"].invoker_iam_disabled && !google_cloud_run_v2_service.app["worker"].invoker_iam_disabled && length(google_cloud_run_domain_mapping.web) == 1 && google_cloud_run_domain_mapping.web[0].name == "address.chain.tokyo" && google_cloud_run_domain_mapping.web[0].project == var.project_id && google_cloud_run_domain_mapping.web[0].location == var.region && google_cloud_run_domain_mapping.web[0].metadata[0].namespace == var.project_id && google_cloud_run_domain_mapping.web[0].spec[0].route_name == "realaddr-event-web" && !google_cloud_run_domain_mapping.web[0].spec[0].force_override && google_cloud_run_domain_mapping.web[0].deletion_policy == "PREVENT"
    error_message = "Domain mapping requires explicit review and must preserve dedicated target and deletion protection."
  }
}
