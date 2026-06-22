terraform {
  required_version = ">= 1.7.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  name_prefix                       = "${var.project_name}-${var.environment}"
  ecr_repository_name               = local.name_prefix
  azs                               = slice(data.aws_availability_zones.available.names, 0, 2)
  ecs_stop_timeout_seconds          = 15
  health_check_grace_period_seconds = 60
  alb_deregistration_delay_seconds  = 30
}

module "ecr" {
  source          = "./modules/ecr"
  name_prefix     = local.name_prefix
  repository_name = local.ecr_repository_name
}

module "vpc" {
  source      = "./modules/vpc"
  name_prefix = local.name_prefix
  azs         = local.azs
}

module "alb" {
  source                       = "./modules/alb"
  name_prefix                  = local.name_prefix
  vpc_id                       = module.vpc.vpc_id
  public_subnets               = module.vpc.public_subnets
  target_group_port            = var.app_port
  deregistration_delay_seconds = local.alb_deregistration_delay_seconds
}

module "ecs_fargate" {
  source                             = "./modules/ecs-fargate"
  name_prefix                        = local.name_prefix
  aws_region                         = var.aws_region
  vpc_id                             = module.vpc.vpc_id
  private_subnets                    = module.vpc.private_subnets
  app_image_uri                      = var.app_image_uri
  app_port                           = var.app_port
  desired_count                      = var.service_desired_count
  min_capacity                       = var.service_min_capacity
  max_capacity                       = var.service_max_capacity
  autoscaling_cpu_target_value       = var.autoscaling_cpu_target_value
  autoscaling_memory_target_value    = var.autoscaling_memory_target_value
  autoscaling_scale_out_cooldown     = var.autoscaling_scale_out_cooldown_seconds
  autoscaling_scale_in_cooldown      = var.autoscaling_scale_in_cooldown_seconds
  log_retention_days                 = var.log_retention_days
  shutdown_timeout_ms                = var.shutdown_timeout_ms
  stop_timeout_seconds               = local.ecs_stop_timeout_seconds
  health_check_grace_period_seconds  = local.health_check_grace_period_seconds
  deployment_minimum_healthy_percent = var.deployment_minimum_healthy_percent
  deployment_maximum_percent         = var.deployment_maximum_percent
  alb_target_group_arn               = module.alb.target_group_arn
  alb_security_group_id              = module.alb.alb_security_group_id

  depends_on = [module.alb]
}

module "observability" {
  source = "./modules/observability"

  name_prefix                           = local.name_prefix
  load_balancer_arn_suffix              = module.alb.load_balancer_arn_suffix
  target_group_arn_suffix               = module.alb.target_group_arn_suffix
  ecs_cluster_name                      = module.ecs_fargate.cluster_name
  ecs_service_name                      = module.ecs_fargate.service_name
  alarm_action_arns                     = var.alarm_action_arns
  ok_action_arns                        = var.ok_action_arns
  target_5xx_alarm_threshold            = var.target_5xx_alarm_threshold
  ecs_cpu_saturation_alarm_threshold    = var.ecs_cpu_saturation_alarm_threshold
  ecs_memory_saturation_alarm_threshold = var.ecs_memory_saturation_alarm_threshold
}

output "alb_dns_name" {
  value = module.alb.alb_dns_name
}

output "ecs_cluster_name" {
  value = module.ecs_fargate.cluster_name
}

output "ecs_service_name" {
  value = module.ecs_fargate.service_name
}

output "ecs_task_definition_arn" {
  value = module.ecs_fargate.task_definition_arn
}

output "app_image_uri" {
  value = var.app_image_uri
}

output "ecr_repository_name" {
  description = "Name of the Terraform-managed private ECR repository."
  value       = module.ecr.repository_name
}

output "ecr_repository_url" {
  description = "URL of the Terraform-managed private ECR repository."
  value       = module.ecr.repository_url
}

output "ecr_repository_arn" {
  description = "ARN of the Terraform-managed private ECR repository."
  value       = module.ecr.repository_arn
}

output "github_ecr_release_role_arn" {
  description = "ARN of the optional GitHub OIDC role for manual ECR image releases. Null when disabled."
  value       = try(aws_iam_role.github_ecr_release[0].arn, null)
}

output "runtime_alarm_names" {
  description = "CloudWatch alarm names for ALB target health and ECS service saturation signals."
  value       = module.observability.alarm_names
}
