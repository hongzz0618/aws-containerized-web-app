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

module "vpc" {
  source = "./modules/vpc"
}

module "efs" {
  source                = "./modules/efs"
  vpc_id                = module.vpc.vpc_id
  subnet_ids            = module.vpc.private_subnets
  ecs_security_group_id = module.ecs_fargate.ecs_security_group_id
}

module "alb" {
  source            = "./modules/alb"
  vpc_id            = module.vpc.vpc_id
  public_subnets    = module.vpc.public_subnets
  target_group_port = 80
}

module "ecs_fargate" {
  source                = "./modules/ecs-fargate"
  aws_region            = var.aws_region
  vpc_id                = module.vpc.vpc_id
  private_subnets       = module.vpc.private_subnets
  cluster_name          = "fargate-web-cluster"
  container_image       = var.container_image
  container_port        = 80
  desired_count         = 2
  log_retention_days    = var.log_retention_days
  alb_target_group_arn  = module.alb.target_group_arn
  alb_security_group_id = module.alb.alb_security_group_id
  efs_id                = module.efs.efs_id
  efs_access_point_id   = module.efs.access_point_id

  depends_on = [module.alb]
}

output "alb_dns_name" {
  value = module.alb.alb_dns_name
}
