output "state_bucket_name" {
  value     = google_storage_bucket.state.name
  sensitive = true
}

output "wif_provider" {
  value     = google_iam_workload_identity_pool_provider.github.name
  sensitive = true
}

output "artifact_repository" {
  value     = google_artifact_registry_repository.images.id
  sensitive = true
}
