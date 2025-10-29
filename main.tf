provider "aws" {
  region = var.aws_region
}

module "vpc" {
  source = "./modules/vpc"
}

module "efs" {
  source     = "./modules/efs"
  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnets
}

module "alb" {
  source            = "./modules/alb"
  vpc_id            = module.vpc.vpc_id
  public_subnets    = module.vpc.public_subnets
  target_group_port = 80
}

module "ecs_fargate" {
  source                = "./modules/ecs-fargate"
  vpc_id                = module.vpc.vpc_id
  private_subnets       = module.vpc.private_subnets
  cluster_name          = "fargate-web-cluster"
  container_image       = var.container_image
  container_port        = 80
  desired_count         = 2
  alb_target_group_arn  = module.alb.target_group_arn
  alb_security_group_id = module.alb.alb_security_group_id
  efs_id                = module.efs.efs_id
  efs_access_point_id   = module.efs.access_point_id
}

output "alb_dns_name" {
  value = module.alb.alb_dns_name
}
