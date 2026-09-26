provider "google" {
  project = var.project_id
  region  = var.region
}

locals {
  github_subject      = "repo:${split("/", var.github_repository)[0]}@${var.github_owner_id}/${split("/", var.github_repository)[1]}@${var.github_repository_id}:environment:event"
  github_workflow_ref = "${var.github_repository}/.github/workflows/deploy-event.yml@refs/heads/main"
  wif_condition = join(" && ", [
    "assertion.repository_id == '${var.github_repository_id}'",
    "assertion.repository_owner_id == '${var.github_owner_id}'",
    "assertion.repository == '${var.github_repository}'",
    "assertion.ref == 'refs/heads/main'",
    "assertion.ref_type == 'branch'",
    "assertion.sub == '${local.github_subject}'",
    "assertion.workflow_ref == '${local.github_workflow_ref}'",
    "assertion.event_name == 'workflow_dispatch'",
  ])
}

resource "google_storage_bucket" "state" {
  project                     = var.project_id
  name                        = var.state_bucket_name
  location                    = var.region
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  versioning {
    enabled = true
  }
  lifecycle {
    prevent_destroy = true
  }
}

resource "google_artifact_registry_repository" "images" {
  project                = var.project_id
  location               = var.region
  repository_id          = var.artifact_repository_id
  format                 = "DOCKER"
  description            = "RealAddr event application images"
  cleanup_policy_dry_run = true
}

resource "google_iam_workload_identity_pool" "github" {
  project                   = var.project_id
  workload_identity_pool_id = var.wif_pool_id
  display_name              = "RealAddr event GitHub"
  disabled                  = !var.wif_enabled
}

resource "google_artifact_registry_repository_iam_member" "deploy_writer" {
  project    = var.project_id
  location   = google_artifact_registry_repository.images.location
  repository = google_artifact_registry_repository.images.repository_id
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${var.deploy_service_account}"
}

resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  disabled                           = !var.wif_enabled
  attribute_condition                = local.wif_condition
  attribute_mapping = {
    "google.subject"          = "assertion.sub"
    "attribute.repository_id" = "assertion.repository_id"
    "attribute.owner_id"      = "assertion.repository_owner_id"
  }
  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
  lifecycle {
    precondition {
      condition     = !var.wif_enabled || var.deploy_workflow_reviewed
      error_message = "Enable WIF only after the deploy workflow and protected event Environment have been reviewed."
    }
  }
}

resource "google_service_account_iam_member" "github_deploy" {
  service_account_id = "projects/${var.project_id}/serviceAccounts/${var.deploy_service_account}"
  role               = "roles/iam.workloadIdentityUser"
  member             = "principal://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/subject/${local.github_subject}"
  lifecycle {
    precondition {
      condition     = endswith(var.deploy_service_account, "@${var.project_id}.iam.gserviceaccount.com")
      error_message = "The reviewed deploy account must belong to the explicitly supplied project."
    }
  }
}
