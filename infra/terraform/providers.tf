provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = var.project
      Env       = var.env
      ManagedBy = "terraform"
    }
  }
}

data "aws_caller_identity" "current" {}

locals {
  name       = "${var.project}-${var.env}"
  account_id = data.aws_caller_identity.current.account_id
}
