terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.4"
    }
  }
}

variable "region" {
  type        = string
  default     = "eu-west-2"
  description = "AWS region"
}

variable "function_name" {
  type        = string
  default     = "carbone-render-pdf"
  description = "Lambda function name"
}

variable "memory_size" {
  type        = number
  default     = 3072
  description = "Lambda memory (MB)"
}

variable "timeout" {
  type        = number
  default     = 30
  description = "Lambda timeout (seconds)"
}

variable "aws_profile" {
  type        = string
  description = "Optional AWS profile name (e.g. nhs-notify-poc) for SSO/credentials"
  default     = ""
}

variable "ephemeral_storage_mb" {
  type        = number
  default     = 1024
  description = "Ephemeral storage size in MB for /tmp (512-10240)"
}

variable "debug_render" {
  type        = bool
  default     = false
  description = "Enable verbose debug rendering logs (sets DEBUG_RENDER=1)"
}

variable "always_soffice" {
  type        = bool
  default     = false
  description = "Force skipping carbone convertTo path and always use soffice CLI conversion"
}

locals {
  libreoffice_layer_arn = "arn:aws:lambda:eu-west-2:764866452798:layer:libreoffice-brotli:1"
  project_root          = abspath("${path.module}/..")
  package_dir           = "${local.project_root}/package"
}

provider "aws" {
  region  = var.region
  profile = var.aws_profile != "" ? var.aws_profile : null
}

provider "archive" {}

provider "random" {}

# Generate a random password for basic authentication
resource "random_password" "basic_auth" {
  length  = 16
  special = false
  upper   = true
  lower   = true
  numeric = true
}

# Build step: run npm install & package (esbuild + zip) before deploying
resource "null_resource" "build" {
  # Rebuild if any of these change (add more patterns as needed)
  triggers = {
    package_json = filesha256("${local.project_root}/package.json")
    lockfile     = fileexists("${local.project_root}/package-lock.json") ? filesha256("${local.project_root}/package-lock.json") : "no-lock"
    index_ts     = filesha256("${local.project_root}/src/index.ts")
    template     = filesha256("${local.project_root}/templates/letter-template-nhs-notify_.docx")
    build_script = filesha256("${local.project_root}/scripts/build.mjs")
  }

  provisioner "local-exec" {
    working_dir = local.project_root
    command     = "npm install && npm run build"
  }
}

data "archive_file" "lambda_package" {
  type        = "zip"
  source_dir  = local.package_dir
  output_path = "${local.project_root}/lambda.zip"
  depends_on  = [null_resource.build]
}

resource "aws_iam_role" "lambda" {
  name               = "${var.function_name}-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy_attachment" "basic" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_lambda_function" "this" {
  function_name    = var.function_name
  role             = aws_iam_role.lambda.arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  filename         = data.archive_file.lambda_package.output_path
  source_code_hash = data.archive_file.lambda_package.output_base64sha256
  timeout          = var.timeout
  memory_size      = var.memory_size
  architectures    = ["x86_64"]
  layers           = [local.libreoffice_layer_arn]
  publish          = false
  depends_on       = [data.archive_file.lambda_package]
  environment {
    variables = {
      NODE_OPTIONS    = "--enable-source-maps"
      DEBUG_RENDER    = var.debug_render ? "1" : "0"
      ALWAYS_SOFFICE  = var.always_soffice ? "1" : "0"
      BASIC_AUTH_PASSWORD = random_password.basic_auth.result
    }
  }

  ephemeral_storage {
    size = var.ephemeral_storage_mb
  }
}

# Public Lambda URL (no auth) - restrict with auth or IAM as needed later
resource "aws_lambda_function_url" "this" {
  function_name      = aws_lambda_function.this.function_name
  authorization_type = "NONE"
}

output "lambda_function_name" {
  value = aws_lambda_function.this.function_name
}

output "lambda_function_url" {
  value = aws_lambda_function_url.this.function_url
}

output "basic_auth_password" {
  value     = random_password.basic_auth.result
  sensitive = true
  description = "Basic authentication password for the Lambda function"
}
