terraform {
  required_version = "= 1.14.6"
  backend "gcs" {}
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "= 8.4.0"
    }
  }
}
