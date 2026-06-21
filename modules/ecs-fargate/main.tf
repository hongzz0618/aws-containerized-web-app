resource "aws_ecs_cluster" "this" {
  name = "${var.name_prefix}-cluster"
}

resource "aws_cloudwatch_log_group" "ecs" {
  name              = "/ecs/${var.name_prefix}/app"
  retention_in_days = var.log_retention_days
}

resource "aws_ecs_task_definition" "this" {
  family                   = "${var.name_prefix}-task"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([
    {
      name                   = "app"
      image                  = var.app_image_uri
      essential              = true
      readonlyRootFilesystem = true
      stopTimeout            = var.stop_timeout_seconds
      environment = [
        {
          name  = "PORT"
          value = tostring(var.app_port)
        },
        {
          name  = "SHUTDOWN_TIMEOUT_MS"
          value = tostring(var.shutdown_timeout_ms)
        }
      ]
      linuxParameters = {
        capabilities = {
          drop = ["ALL"]
        }
      }
      portMappings = [{
        containerPort = var.app_port
        hostPort      = var.app_port
        protocol      = "tcp"
      }]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.ecs.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "ecs"
        }
      }
    }
  ])

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }
}

resource "aws_ecs_service" "this" {
  name            = "${var.name_prefix}-service"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.this.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  health_check_grace_period_seconds  = var.health_check_grace_period_seconds
  deployment_minimum_healthy_percent = var.deployment_minimum_healthy_percent
  deployment_maximum_percent         = var.deployment_maximum_percent

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = var.private_subnets
    security_groups  = [aws_security_group.ecs.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = var.alb_target_group_arn
    container_name   = "app"
    container_port   = var.app_port
  }

  lifecycle {
    ignore_changes = [desired_count]

    precondition {
      condition     = var.min_capacity <= var.desired_count && var.desired_count <= var.max_capacity
      error_message = "desired_count must be within min_capacity and max_capacity."
    }

    precondition {
      condition     = var.deployment_maximum_percent >= var.deployment_minimum_healthy_percent
      error_message = "deployment_maximum_percent must be greater than or equal to deployment_minimum_healthy_percent."
    }
  }
}

resource "aws_appautoscaling_target" "ecs_service" {
  max_capacity       = var.max_capacity
  min_capacity       = var.min_capacity
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.this.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"

  lifecycle {
    precondition {
      condition     = var.min_capacity <= var.max_capacity
      error_message = "min_capacity must be less than or equal to max_capacity."
    }
  }
}

resource "aws_appautoscaling_policy" "cpu_target_tracking" {
  name               = "${var.name_prefix}-cpu-target-tracking"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.ecs_service.resource_id
  scalable_dimension = aws_appautoscaling_target.ecs_service.scalable_dimension
  service_namespace  = aws_appautoscaling_target.ecs_service.service_namespace

  target_tracking_scaling_policy_configuration {
    target_value       = var.autoscaling_cpu_target_value
    scale_in_cooldown  = var.autoscaling_scale_in_cooldown
    scale_out_cooldown = var.autoscaling_scale_out_cooldown

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}

resource "aws_appautoscaling_policy" "memory_target_tracking" {
  name               = "${var.name_prefix}-memory-target-tracking"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.ecs_service.resource_id
  scalable_dimension = aws_appautoscaling_target.ecs_service.scalable_dimension
  service_namespace  = aws_appautoscaling_target.ecs_service.service_namespace

  target_tracking_scaling_policy_configuration {
    target_value       = var.autoscaling_memory_target_value
    scale_in_cooldown  = var.autoscaling_scale_in_cooldown
    scale_out_cooldown = var.autoscaling_scale_out_cooldown

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageMemoryUtilization"
    }
  }
}

resource "aws_security_group" "ecs" {
  name   = "${var.name_prefix}-ecs-sg"
  vpc_id = var.vpc_id

  ingress {
    from_port       = var.app_port
    to_port         = var.app_port
    protocol        = "tcp"
    security_groups = [var.alb_security_group_id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# IAM roles
resource "aws_iam_role" "execution" {
  name               = "${var.name_prefix}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "execution_policy" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role" "task" {
  name               = "${var.name_prefix}-ecs-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

variable "name_prefix" {
  type = string
}

variable "aws_region" {
  type = string
}

variable "app_image_uri" {
  type = string
}

variable "app_port" {
  type = number
}

variable "shutdown_timeout_ms" {
  type = number
}

variable "stop_timeout_seconds" {
  type = number
}

variable "health_check_grace_period_seconds" {
  type = number
}

variable "desired_count" {
  type = number
}

variable "min_capacity" {
  type = number
}

variable "max_capacity" {
  type = number
}

variable "autoscaling_cpu_target_value" {
  type = number
}

variable "autoscaling_memory_target_value" {
  type = number
}

variable "autoscaling_scale_out_cooldown" {
  type = number
}

variable "autoscaling_scale_in_cooldown" {
  type = number
}

variable "deployment_minimum_healthy_percent" {
  type = number
}

variable "deployment_maximum_percent" {
  type = number
}

variable "log_retention_days" {
  type = number
}

variable "alb_target_group_arn" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "private_subnets" {
  type = list(string)
}

variable "alb_security_group_id" {
  type = string
}

output "ecs_security_group_id" {
  value = aws_security_group.ecs.id
}

output "cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "service_name" {
  value = aws_ecs_service.this.name
}

output "task_definition_arn" {
  value = aws_ecs_task_definition.this.arn
}
