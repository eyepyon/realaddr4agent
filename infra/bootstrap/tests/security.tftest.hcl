mock_provider "google" {
  mock_resource "google_iam_workload_identity_pool" {
    override_during = plan
    defaults = {
      name = "projects/123456789012/locations/global/workloadIdentityPools/realaddr-event-gh"
    }
  }
}

variables {
  project_id             = "demo-realaddr-local"
  region                 = "us-central1"
  state_bucket_name      = "realaddr-event-test-state"
  deploy_service_account = "realaddr-event-test@demo-realaddr-local.iam.gserviceaccount.com"
  github_repository      = "test-owner/test-repository"
  github_repository_id   = "123456"
  github_owner_id        = "654321"
}

run "bootstrap_defaults" {
  command = plan
  assert {
    condition     = google_storage_bucket.state.uniform_bucket_level_access && google_storage_bucket.state.public_access_prevention == "enforced" && google_storage_bucket.state.versioning[0].enabled && !google_storage_bucket.state.force_destroy
    error_message = "State storage must be private, versioned and non-destructive."
  }
  assert {
    condition     = google_iam_workload_identity_pool.github.disabled && google_iam_workload_identity_pool_provider.github.disabled
    error_message = "Unreviewed deployment trust must stay disabled."
  }
  assert {
    condition = google_iam_workload_identity_pool_provider.github.attribute_condition == join(" && ", [
      "assertion.repository_id == '123456'",
      "assertion.repository_owner_id == '654321'",
      "assertion.repository == 'test-owner/test-repository'",
      "assertion.ref == 'refs/heads/main'",
      "assertion.ref_type == 'branch'",
      "assertion.sub == 'repo:test-owner/test-repository:environment:event'",
      "assertion.workflow_ref == 'test-owner/test-repository/.github/workflows/deploy-event.yml@refs/heads/main'",
      "assertion.event_name == 'workflow_dispatch'",
    ])
    error_message = "WIF trust must retain every repository, branch, environment and workflow restriction."
  }
  assert {
    condition     = google_service_account_iam_member.github_deploy.role == "roles/iam.workloadIdentityUser" && google_service_account_iam_member.github_deploy.service_account_id == "projects/demo-realaddr-local/serviceAccounts/realaddr-event-test@demo-realaddr-local.iam.gserviceaccount.com"
    error_message = "Impersonation must target only the explicitly supplied existing account."
  }
  assert {
    condition     = google_service_account_iam_member.github_deploy.member == "principal://iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/realaddr-event-gh/subject/repo:test-owner/test-repository:environment:event"
    error_message = "Impersonation must use the exact subject in the dedicated pool."
  }
}

run "reject_unreviewed_wif" {
  command = plan
  variables {
    wif_enabled = true
  }
  expect_failures = [google_iam_workload_identity_pool_provider.github]
}
