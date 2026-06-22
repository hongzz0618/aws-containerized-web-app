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
  description = "Digest-pinned container image reference used by the ECS task. Must end with @sha256:<64 lowercase hexadecimal characters>, for example 123456789012.dkr.ecr.eu-west-1.amazonaws.com/example@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa."
  type        = string

  validation {
    condition     = can(regex("^[^\\s@]+@sha256:[0-9a-f]{64}$", var.app_image_uri))
    error_message = "app_image_uri must be a digest-pinned image reference ending with @sha256:<64 lowercase hexadecimal characters>, for example 123456789012.dkr.ecr.eu-west-1.amazonaws.com/example@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa."
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

variable "service_desired_count" {
  description = "Initial ECS service desired task count. Application Auto Scaling may adjust this value at runtime after creation."
  type        = number
  default     = 1

  validation {
    condition     = var.service_desired_count >= 1 && var.service_desired_count <= 10
    error_message = "service_desired_count must be between 1 and 10."
  }
}

variable "service_min_capacity" {
  description = "Minimum ECS service task count enforced by Application Auto Scaling."
  type        = number
  default     = 1

  validation {
    condition     = var.service_min_capacity >= 1 && var.service_min_capacity <= 10
    error_message = "service_min_capacity must be between 1 and 10."
  }
}

variable "service_max_capacity" {
  description = "Maximum ECS service task count allowed by Application Auto Scaling."
  type        = number
  default     = 3

  validation {
    condition     = var.service_max_capacity >= 1 && var.service_max_capacity <= 10
    error_message = "service_max_capacity must be between 1 and 10."
  }
}

variable "autoscaling_cpu_target_value" {
  description = "Average ECS service CPU utilization percentage targeted by the CPU target tracking policy."
  type        = number
  default     = 65

  validation {
    condition     = var.autoscaling_cpu_target_value >= 40 && var.autoscaling_cpu_target_value <= 90
    error_message = "autoscaling_cpu_target_value must be between 40 and 90."
  }
}

variable "autoscaling_memory_target_value" {
  description = "Average ECS service memory utilization percentage targeted by the memory target tracking policy."
  type        = number
  default     = 75

  validation {
    condition     = var.autoscaling_memory_target_value >= 40 && var.autoscaling_memory_target_value <= 90
    error_message = "autoscaling_memory_target_value must be between 40 and 90."
  }
}

variable "autoscaling_scale_out_cooldown_seconds" {
  description = "Cooldown after an ECS service scale-out action."
  type        = number
  default     = 60

  validation {
    condition     = var.autoscaling_scale_out_cooldown_seconds >= 0 && var.autoscaling_scale_out_cooldown_seconds <= 900
    error_message = "autoscaling_scale_out_cooldown_seconds must be between 0 and 900."
  }
}

variable "autoscaling_scale_in_cooldown_seconds" {
  description = "Cooldown after an ECS service scale-in action."
  type        = number
  default     = 300

  validation {
    condition     = var.autoscaling_scale_in_cooldown_seconds >= 0 && var.autoscaling_scale_in_cooldown_seconds <= 1800
    error_message = "autoscaling_scale_in_cooldown_seconds must be between 0 and 1800."
  }
}

variable "deployment_minimum_healthy_percent" {
  description = "Minimum healthy ECS service task percentage maintained during rolling deployments."
  type        = number
  default     = 100

  validation {
    condition     = var.deployment_minimum_healthy_percent >= 0 && var.deployment_minimum_healthy_percent <= 100
    error_message = "deployment_minimum_healthy_percent must be between 0 and 100."
  }
}

variable "deployment_maximum_percent" {
  description = "Maximum ECS service task percentage allowed during rolling deployments."
  type        = number
  default     = 200

  validation {
    condition     = var.deployment_maximum_percent >= 100 && var.deployment_maximum_percent <= 400
    error_message = "deployment_maximum_percent must be between 100 and 400."
  }
}

variable "alarm_action_arns" {
  description = "Optional action ARNs, such as existing SNS topic ARNs, invoked when runtime alarms enter ALARM state."
  type        = list(string)
  default     = []

  validation {
    condition = alltrue([
      for arn in var.alarm_action_arns : can(regex("^arn:aws[a-zA-Z-]*:[^\\s]+$", arn))
    ])
    error_message = "alarm_action_arns entries must be valid-looking AWS ARNs without whitespace."
  }
}

variable "ok_action_arns" {
  description = "Optional action ARNs, such as existing SNS topic ARNs, invoked when runtime alarms return to OK state."
  type        = list(string)
  default     = []

  validation {
    condition = alltrue([
      for arn in var.ok_action_arns : can(regex("^arn:aws[a-zA-Z-]*:[^\\s]+$", arn))
    ])
    error_message = "ok_action_arns entries must be valid-looking AWS ARNs without whitespace."
  }
}

variable "target_5xx_alarm_threshold" {
  description = "Target 5XX response count threshold over the alarm evaluation window."
  type        = number
  default     = 5

  validation {
    condition     = var.target_5xx_alarm_threshold >= 1 && var.target_5xx_alarm_threshold <= 1000
    error_message = "target_5xx_alarm_threshold must be between 1 and 1000."
  }
}

variable "ecs_cpu_saturation_alarm_threshold" {
  description = "Average ECS service CPU utilization percentage treated as saturation above the autoscaling target."
  type        = number
  default     = 90

  validation {
    condition     = var.ecs_cpu_saturation_alarm_threshold >= 75 && var.ecs_cpu_saturation_alarm_threshold <= 100
    error_message = "ecs_cpu_saturation_alarm_threshold must be between 75 and 100."
  }
}

variable "ecs_memory_saturation_alarm_threshold" {
  description = "Average ECS service memory utilization percentage treated as saturation above the autoscaling target."
  type        = number
  default     = 90

  validation {
    condition     = var.ecs_memory_saturation_alarm_threshold >= 75 && var.ecs_memory_saturation_alarm_threshold <= 100
    error_message = "ecs_memory_saturation_alarm_threshold must be between 75 and 100."
  }
}

variable "enable_github_ecr_release_role" {
  description = "Whether to create the GitHub OIDC IAM role used only for manual ECR image releases."
  type        = bool
  default     = false
}

variable "github_oidc_provider_arn" {
  description = "Existing account-level GitHub Actions OIDC provider ARN. Required when enable_github_ecr_release_role is true."
  type        = string
  default     = ""

  validation {
    condition = (
      trimspace(var.github_oidc_provider_arn) == "" ||
      can(regex("^arn:aws[a-zA-Z-]*:iam::[0-9]{12}:oidc-provider/token\\.actions\\.githubusercontent\\.com$", trimspace(var.github_oidc_provider_arn)))
    )
    error_message = "github_oidc_provider_arn must be empty or an ARN for the token.actions.githubusercontent.com IAM OIDC provider."
  }
}

variable "github_repository" {
  description = "GitHub repository allowed to assume the manual ECR release role, formatted as owner/repository."
  type        = string
  default     = "hongzz0618/aws-containerized-web-app"

  validation {
    condition = (
      trimspace(var.github_repository) == "" ||
      (
        can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", trimspace(var.github_repository))) &&
        !can(regex("(^https?://|\\.git$|\\s|//)", trimspace(var.github_repository)))
      )
    )
    error_message = "github_repository must be empty or use owner/repository format without a URL scheme, .git suffix, whitespace, or extra slashes."
  }
}

variable "github_release_environment" {
  description = "GitHub Environment name bound into the OIDC trust subject for manual ECR releases."
  type        = string
  default     = "container-release"

  validation {
    condition = (
      trimspace(var.github_release_environment) == "" ||
      can(regex("^[A-Za-z0-9_.-]+$", trimspace(var.github_release_environment)))
    )
    error_message = "github_release_environment must be empty or contain only letters, numbers, dots, underscores, or hyphens."
  }
}

check "service_capacity" {
  assert {
    condition     = var.service_min_capacity <= var.service_desired_count && var.service_desired_count <= var.service_max_capacity
    error_message = "service_desired_count must be within service_min_capacity and service_max_capacity."
  }
}

check "deployment_percentages" {
  assert {
    condition     = var.deployment_maximum_percent >= var.deployment_minimum_healthy_percent
    error_message = "deployment_maximum_percent must be greater than or equal to deployment_minimum_healthy_percent."
  }
}

check "github_ecr_release_role" {
  assert {
    condition = (
      !var.enable_github_ecr_release_role ||
      (
        trimspace(var.github_oidc_provider_arn) != "" &&
        trimspace(var.github_repository) != "" &&
        trimspace(var.github_release_environment) != ""
      )
    )
    error_message = "When enable_github_ecr_release_role is true, github_oidc_provider_arn, github_repository, and github_release_environment must be set."
  }
}
