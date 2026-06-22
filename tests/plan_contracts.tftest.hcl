mock_provider "aws" {
  mock_data "aws_availability_zones" {
    defaults = {
      names = ["us-east-1a", "us-east-1b"]
    }
  }

  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "123456789012"
    }
  }

  mock_data "aws_partition" {
    defaults = {
      partition = "aws"
    }
  }

  mock_data "aws_iam_policy_document" {
    defaults = {
      json = <<-EOT
      {
        "Version": "2012-10-17",
        "Statement": [
          {
            "Effect": "Allow",
            "Action": "sts:AssumeRole",
            "Principal": {
              "Service": "ecs-tasks.amazonaws.com"
            }
          }
        ]
      }
      EOT
    }
  }
}

variables {
  app_image_uri = "123456789012.dkr.ecr.us-east-1.amazonaws.com/container-web-dev@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}

run "accepts_digest_pinned_image_uri" {
  command = plan

  assert {
    condition     = output.app_image_uri == var.app_image_uri
    error_message = "A digest-pinned application image URI should be accepted and exposed unchanged."
  }
}

run "rejects_tag_only_image_uri" {
  command = plan

  variables {
    app_image_uri = "123456789012.dkr.ecr.us-east-1.amazonaws.com/container-web-dev:git-abc123"
  }

  expect_failures = [var.app_image_uri]
}

run "rejects_latest_image_uri" {
  command = plan

  variables {
    app_image_uri = "123456789012.dkr.ecr.us-east-1.amazonaws.com/container-web-dev:latest"
  }

  expect_failures = [var.app_image_uri]
}

run "rejects_malformed_digest_image_uri" {
  command = plan

  variables {
    app_image_uri = "123456789012.dkr.ecr.us-east-1.amazonaws.com/container-web-dev@sha256:not-a-valid-digest"
  }

  expect_failures = [var.app_image_uri]
}

run "ecr_repository_contract" {
  command = plan

  module {
    source = "./modules/ecr"
  }

  variables {
    name_prefix     = "container-web-dev"
    repository_name = "container-web-dev"
  }

  assert {
    condition     = aws_ecr_repository.app.image_tag_mutability == "IMMUTABLE"
    error_message = "The ECR repository must keep image tags immutable."
  }

  assert {
    condition     = aws_ecr_repository.app.image_scanning_configuration[0].scan_on_push == true
    error_message = "The ECR repository must scan images on push."
  }

  assert {
    condition     = aws_ecr_repository.app.force_delete == false
    error_message = "The ECR repository must not force-delete images by default."
  }

  assert {
    condition     = length(jsondecode(aws_ecr_lifecycle_policy.app.policy).rules) > 0
    error_message = "The ECR repository must include a lifecycle policy."
  }
}

run "ecs_fargate_contract" {
  command = plan

  module {
    source = "./modules/ecs-fargate"
  }

  variables {
    name_prefix                        = "container-web-dev"
    aws_region                         = "us-east-1"
    app_image_uri                      = var.app_image_uri
    app_port                           = 3000
    shutdown_timeout_ms                = 10000
    stop_timeout_seconds               = 15
    health_check_grace_period_seconds  = 60
    desired_count                      = 1
    min_capacity                       = 1
    max_capacity                       = 3
    autoscaling_cpu_target_value       = 65
    autoscaling_memory_target_value    = 75
    autoscaling_scale_out_cooldown     = 60
    autoscaling_scale_in_cooldown      = 300
    deployment_minimum_healthy_percent = 100
    deployment_maximum_percent         = 200
    log_retention_days                 = 14
    alb_target_group_arn               = "arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/container-web-dev-tg/1234567890abcdef"
    vpc_id                             = "vpc-12345678"
    private_subnets                    = ["subnet-11111111", "subnet-22222222"]
    alb_security_group_id              = "sg-alb12345"
  }

  assert {
    condition     = contains(aws_ecs_task_definition.this.requires_compatibilities, "FARGATE")
    error_message = "The ECS task definition must require Fargate compatibility."
  }

  assert {
    condition     = aws_ecs_task_definition.this.network_mode == "awsvpc"
    error_message = "The ECS task definition must use awsvpc networking."
  }

  assert {
    condition     = aws_ecs_service.this.network_configuration[0].assign_public_ip == false
    error_message = "The ECS service must not assign public IP addresses to tasks."
  }

  assert {
    condition     = jsondecode(aws_ecs_task_definition.this.container_definitions)[0].readonlyRootFilesystem == true
    error_message = "The application container must use a read-only root filesystem."
  }

  assert {
    condition     = contains(jsondecode(aws_ecs_task_definition.this.container_definitions)[0].linuxParameters.capabilities.drop, "ALL")
    error_message = "The application container must drop all Linux capabilities."
  }

  assert {
    condition     = aws_ecs_service.this.deployment_circuit_breaker[0].enable == true
    error_message = "The ECS deployment circuit breaker must be enabled."
  }

  assert {
    condition     = aws_ecs_service.this.deployment_circuit_breaker[0].rollback == true
    error_message = "The ECS deployment circuit breaker must roll back failed deployments."
  }

  assert {
    condition     = var.min_capacity <= aws_ecs_service.this.desired_count && aws_ecs_service.this.desired_count <= var.max_capacity
    error_message = "The ECS desired count must stay within the configured autoscaling min/max range."
  }

  assert {
    condition     = aws_ecs_service.this.health_check_grace_period_seconds > 0
    error_message = "The ECS service must include a health check grace period."
  }

  assert {
    condition     = jsondecode(aws_ecs_task_definition.this.container_definitions)[0].stopTimeout * 1000 > var.shutdown_timeout_ms
    error_message = "The ECS stop timeout must exceed the application shutdown timeout."
  }
}

run "alb_contract" {
  command = plan

  module {
    source = "./modules/alb"
  }

  variables {
    name_prefix                  = "container-web-dev"
    vpc_id                       = "vpc-12345678"
    public_subnets               = ["subnet-aaaaaaaa", "subnet-bbbbbbbb"]
    target_group_port            = 3000
    deregistration_delay_seconds = 30
  }

  assert {
    condition     = aws_lb_target_group.this.target_type == "ip"
    error_message = "The ALB target group must target ECS tasks by IP."
  }

  assert {
    condition     = aws_lb_target_group.this.health_check[0].path == "/health"
    error_message = "The ALB health check path must be /health."
  }

  assert {
    condition     = aws_lb_target_group.this.port == var.target_group_port
    error_message = "The target group port must match the application port."
  }

  assert {
    condition     = aws_lb_listener.this.default_action[0].type == "forward"
    error_message = "The ALB listener must forward traffic to a target group."
  }
}

run "ecs_alb_wiring_contract" {
  command = plan

  module {
    source = "./modules/ecs-fargate"
  }

  variables {
    name_prefix                        = "container-web-dev"
    aws_region                         = "us-east-1"
    app_image_uri                      = var.app_image_uri
    app_port                           = 3000
    shutdown_timeout_ms                = 10000
    stop_timeout_seconds               = 15
    health_check_grace_period_seconds  = 60
    desired_count                      = 1
    min_capacity                       = 1
    max_capacity                       = 3
    autoscaling_cpu_target_value       = 65
    autoscaling_memory_target_value    = 75
    autoscaling_scale_out_cooldown     = 60
    autoscaling_scale_in_cooldown      = 300
    deployment_minimum_healthy_percent = 100
    deployment_maximum_percent         = 200
    log_retention_days                 = 14
    alb_target_group_arn               = "arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/container-web-dev-tg/1234567890abcdef"
    vpc_id                             = "vpc-12345678"
    private_subnets                    = ["subnet-11111111", "subnet-22222222"]
    alb_security_group_id              = "sg-alb12345"
  }

  assert {
    condition     = one(aws_ecs_service.this.load_balancer).container_port == var.app_port
    error_message = "The ECS service load balancer port must match the application port."
  }

  assert {
    condition     = one(aws_ecs_service.this.load_balancer).target_group_arn == var.alb_target_group_arn
    error_message = "The ECS service must attach to the configured ALB target group."
  }

  assert {
    condition     = one(aws_security_group.ecs.ingress).security_groups == toset([var.alb_security_group_id])
    error_message = "The ECS security group must only allow ingress from the ALB security group."
  }
}

run "autoscaling_contract" {
  command = plan

  module {
    source = "./modules/ecs-fargate"
  }

  variables {
    name_prefix                        = "container-web-dev"
    aws_region                         = "us-east-1"
    app_image_uri                      = var.app_image_uri
    app_port                           = 3000
    shutdown_timeout_ms                = 10000
    stop_timeout_seconds               = 15
    health_check_grace_period_seconds  = 60
    desired_count                      = 1
    min_capacity                       = 1
    max_capacity                       = 3
    autoscaling_cpu_target_value       = 65
    autoscaling_memory_target_value    = 75
    autoscaling_scale_out_cooldown     = 60
    autoscaling_scale_in_cooldown      = 300
    deployment_minimum_healthy_percent = 100
    deployment_maximum_percent         = 200
    log_retention_days                 = 14
    alb_target_group_arn               = "arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/container-web-dev-tg/1234567890abcdef"
    vpc_id                             = "vpc-12345678"
    private_subnets                    = ["subnet-11111111", "subnet-22222222"]
    alb_security_group_id              = "sg-alb12345"
  }

  assert {
    condition     = aws_appautoscaling_target.ecs_service.min_capacity == var.min_capacity
    error_message = "The ECS autoscaling target min capacity must match the configured service minimum."
  }

  assert {
    condition     = aws_appautoscaling_target.ecs_service.max_capacity == var.max_capacity
    error_message = "The ECS autoscaling target max capacity must match the configured service maximum."
  }

  assert {
    condition     = aws_appautoscaling_policy.cpu_target_tracking.target_tracking_scaling_policy_configuration[0].predefined_metric_specification[0].predefined_metric_type == "ECSServiceAverageCPUUtilization"
    error_message = "The ECS service must include CPU target tracking autoscaling."
  }

  assert {
    condition     = aws_appautoscaling_policy.memory_target_tracking.target_tracking_scaling_policy_configuration[0].predefined_metric_specification[0].predefined_metric_type == "ECSServiceAverageMemoryUtilization"
    error_message = "The ECS service must include memory target tracking autoscaling."
  }

  assert {
    condition     = aws_appautoscaling_policy.cpu_target_tracking.target_tracking_scaling_policy_configuration[0].scale_out_cooldown <= aws_appautoscaling_policy.cpu_target_tracking.target_tracking_scaling_policy_configuration[0].scale_in_cooldown
    error_message = "CPU scale-out cooldown must be shorter than or equal to scale-in cooldown."
  }

  assert {
    condition     = aws_appautoscaling_policy.memory_target_tracking.target_tracking_scaling_policy_configuration[0].scale_out_cooldown <= aws_appautoscaling_policy.memory_target_tracking.target_tracking_scaling_policy_configuration[0].scale_in_cooldown
    error_message = "Memory scale-out cooldown must be shorter than or equal to scale-in cooldown."
  }
}
