terraform {
  required_version = ">= 1.5.0"

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
  azs                               = slice(data.aws_availability_zones.available.names, 0, 2)
  ecs_stop_timeout_seconds          = 15
  health_check_grace_period_seconds = 60
  alb_deregistration_delay_seconds  = 30
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
  source                            = "./modules/ecs-fargate"
  name_prefix                       = local.name_prefix
  aws_region                        = var.aws_region
  vpc_id                            = module.vpc.vpc_id
  private_subnets                   = module.vpc.private_subnets
  app_image_uri                     = var.app_image_uri
  app_port                          = var.app_port
  desired_count                     = 2
  log_retention_days                = var.log_retention_days
  shutdown_timeout_ms               = var.shutdown_timeout_ms
  stop_timeout_seconds              = local.ecs_stop_timeout_seconds
  health_check_grace_period_seconds = local.health_check_grace_period_seconds
  alb_target_group_arn              = module.alb.target_group_arn
  alb_security_group_id             = module.alb.alb_security_group_id

  depends_on = [module.alb]
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
