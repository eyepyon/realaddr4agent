output "runtime_accounts" {
  value     = { for role, account in google_service_account.app : role => account.email }
  sensitive = true
}
output "service_urls" {
  value     = { for role, service in google_cloud_run_v2_service.app : role => service.uri }
  sensitive = true
}
output "queue_id" {
  value     = google_cloud_tasks_queue.jobs.id
  sensitive = true
}
