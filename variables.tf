variable "aws_region" {
  description = "AWS region to deploy resources"
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  description = "Short name used as a prefix for AWS resources"
  type        = string
  default     = "container-web"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,16}[a-z0-9]$", var.project_name))
    error_message = "project_name must be 3-18 lowercase letters, numbers, or hyphens, start with a letter, and end with a letter or number."
  }
}

variable "environment" {
  description = "Short environment name used in AWS resource names"
  type        = string
  default     = "dev"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,6}[a-z0-9]$", var.environment))
    error_message = "environment must be 3-8 lowercase letters, numbers, or hyphens, start with a letter, and end with a letter or number."
  }
}

variable "app_image_uri" {
  description = "Container image reference used by the ECS task. Prefer an immutable digest such as 123456789012.dkr.ecr.eu-west-1.amazonaws.com/example@sha256:<digest>."
  type        = string

  validation {
    condition = (
      length(trimspace(var.app_image_uri)) > 0 &&
      !can(regex("\\s", var.app_image_uri)) &&
      lower(trimspace(var.app_image_uri)) != "latest" &&
      !can(regex(":latest$", lower(trimspace(var.app_image_uri)))) &&
      (
        can(regex("@sha256:[0-9a-fA-F]{64}$", trimspace(var.app_image_uri))) ||
        can(regex(":[^/:@]+$", trimspace(var.app_image_uri)))
      )
    )
    error_message = "app_image_uri must be non-empty, contain no whitespace, include an explicit non-latest tag or sha256 digest, and must not be latest or end in :latest."
  }
}

variable "app_port" {
  description = "Port exposed by the Node.js application container and targeted by the ALB target group"
  type        = number
  default     = 3000

  validation {
    condition     = var.app_port >= 1 && var.app_port <= 65535
    error_message = "app_port must be between 1 and 65535."
  }
}

variable "shutdown_timeout_ms" {
  description = "Application graceful shutdown deadline passed to the container as SHUTDOWN_TIMEOUT_MS"
  type        = number
  default     = 10000

  validation {
    condition     = var.shutdown_timeout_ms >= 100 && var.shutdown_timeout_ms <= 120000
    error_message = "shutdown_timeout_ms must be between 100 and 120000."
  }
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention period for ECS task logs"
  type        = number
  default     = 14
}
