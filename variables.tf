variable "aws_region" {
  description = "AWS region to deploy resources"
  type        = string
  default     = "us-east-1"
}

variable "container_image" {
  description = "Docker image for ECS Fargate task"
  type        = string
  default     = "nginx:latest"
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention period for ECS task logs"
  type        = number
  default     = 14
}
