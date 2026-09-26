resource "google_firestore_database" "realaddr" {
  count                   = var.firestore_database_ownership_reviewed ? 1 : 0
  project                 = var.project_id
  name                    = "realaddr"
  location_id             = var.region
  type                    = "FIRESTORE_NATIVE"
  concurrency_mode        = "PESSIMISTIC"
  delete_protection_state = "DELETE_PROTECTION_ENABLED"
  deletion_policy         = "ABANDON"
  lifecycle { prevent_destroy = true }
}

resource "google_project_iam_member" "firestore_realaddr" {
  for_each = var.firestore_access_reviewed && var.firestore_database_ownership_reviewed ? local.runtime_roles : toset([])
  project  = var.project_id
  role     = "roles/datastore.user"
  member   = "serviceAccount:${google_service_account.app[each.key].email}"
  condition {
    title      = "realaddr-event-realaddr-database"
    expression = "resource.name == 'projects/${var.project_id}/databases/realaddr'"
  }
  depends_on = [google_firestore_database.realaddr]
}

resource "google_firestore_index" "realaddr_outbox_due" {
  count       = var.firestore_database_ownership_reviewed ? 1 : 0
  project     = var.project_id
  database    = google_firestore_database.realaddr[0].name
  collection  = "realaddr_event_outbox"
  query_scope = "COLLECTION"
  fields {
    field_path = "state"
    order      = "ASCENDING"
  }
  fields {
    field_path = "availableAt"
    order      = "ASCENDING"
  }
}

resource "google_firestore_index" "realaddr_owner_lists" {
  for_each    = var.firestore_database_ownership_reviewed ? { orders = "createdAt", leases = "updatedAt" } : {}
  project     = var.project_id
  database    = google_firestore_database.realaddr[0].name
  collection  = "realaddr_event_${each.key}"
  query_scope = "COLLECTION"
  fields {
    field_path = "tenantId"
    order      = "ASCENDING"
  }
  fields {
    field_path = "agentId"
    order      = "ASCENDING"
  }
  fields {
    field_path = each.value
    order      = "DESCENDING"
  }
  fields {
    field_path = "__name__"
    order      = "DESCENDING"
  }
}
