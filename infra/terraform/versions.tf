terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Bucket compartido de la cuenta, una key por proyecto. `use_lockfile` usa el
  # locking nativo de S3 (Terraform >= 1.10): no hace falta tabla de DynamoDB.
  backend "s3" {
    bucket       = "sdlc-terraform-state"
    key          = "sdlc-mcp/terraform.tfstate"
    region       = "us-east-1"
    use_lockfile = true
  }
}
