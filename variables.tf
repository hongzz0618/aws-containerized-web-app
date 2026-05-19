variable "aws_region" {
  description = "AWS region to deploy resources"
  type        = string
  default     = "us-east-1"
}

variable "container_image" {
  description = "Docker image for ECS Fargate task. Use an explicit tag or immutable digest; do not use latest."
  type        = string
  default     = "nginx:1.27-alpine"

  validation {
    condition = (
      can(regex("@sha256:[0-9a-fA-F]{64}$", var.container_image)) ||
      (
        can(regex(":[^/:@]+$", var.container_image)) &&
        !can(regex(":latest$", lower(var.container_image)))
      )
    )
    error_message = "container_image must use an explicit non-latest tag or an immutable sha256 digest."
  }
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention period for ECS task logs"
  type        = number
  default     = 14
}
