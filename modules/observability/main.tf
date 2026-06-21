resource "aws_cloudwatch_metric_alarm" "alb_unhealthy_targets" {
  alarm_name          = "${var.name_prefix}-alb-unhealthy-targets"
  alarm_description   = "ALB has at least one unhealthy ECS target for a sustained window."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  statistic           = "Average"
  period              = 60
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_action_arns
  ok_actions          = var.ok_action_arns

  dimensions = {
    LoadBalancer = var.load_balancer_arn_suffix
    TargetGroup  = var.target_group_arn_suffix
  }
}

resource "aws_cloudwatch_metric_alarm" "target_5xx" {
  alarm_name          = "${var.name_prefix}-target-5xx"
  alarm_description   = "Application targets are returning repeated HTTP 5XX responses through the ALB."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  threshold           = var.target_5xx_alarm_threshold
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_action_arns
  ok_actions          = var.ok_action_arns

  dimensions = {
    LoadBalancer = var.load_balancer_arn_suffix
    TargetGroup  = var.target_group_arn_suffix
  }
}

resource "aws_cloudwatch_metric_alarm" "ecs_cpu_saturation" {
  alarm_name          = "${var.name_prefix}-ecs-cpu-saturation"
  alarm_description   = "ECS service CPU utilization remains high above the target tracking threshold."
  namespace           = "AWS/ECS"
  metric_name         = "CPUUtilization"
  statistic           = "Average"
  period              = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 5
  threshold           = var.ecs_cpu_saturation_alarm_threshold
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_action_arns
  ok_actions          = var.ok_action_arns

  dimensions = {
    ClusterName = var.ecs_cluster_name
    ServiceName = var.ecs_service_name
  }
}

resource "aws_cloudwatch_metric_alarm" "ecs_memory_saturation" {
  alarm_name          = "${var.name_prefix}-ecs-memory-saturation"
  alarm_description   = "ECS service memory utilization remains high above the target tracking threshold."
  namespace           = "AWS/ECS"
  metric_name         = "MemoryUtilization"
  statistic           = "Average"
  period              = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 5
  threshold           = var.ecs_memory_saturation_alarm_threshold
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_action_arns
  ok_actions          = var.ok_action_arns

  dimensions = {
    ClusterName = var.ecs_cluster_name
    ServiceName = var.ecs_service_name
  }
}

variable "name_prefix" {
  description = "Project/environment prefix used in alarm names."
  type        = string
}

variable "load_balancer_arn_suffix" {
  description = "Application Load Balancer ARN suffix used by CloudWatch metric dimensions."
  type        = string
}

variable "target_group_arn_suffix" {
  description = "Target group ARN suffix used by CloudWatch metric dimensions."
  type        = string
}

variable "ecs_cluster_name" {
  description = "ECS cluster name used by service-level CloudWatch metric dimensions."
  type        = string
}

variable "ecs_service_name" {
  description = "ECS service name used by service-level CloudWatch metric dimensions."
  type        = string
}

variable "alarm_action_arns" {
  description = "Optional action ARNs invoked when alarms enter ALARM state."
  type        = list(string)
}

variable "ok_action_arns" {
  description = "Optional action ARNs invoked when alarms return to OK state."
  type        = list(string)
}

variable "target_5xx_alarm_threshold" {
  description = "Target 5XX response count threshold over the alarm evaluation window."
  type        = number
}

variable "ecs_cpu_saturation_alarm_threshold" {
  description = "Average ECS service CPU utilization percentage treated as saturation."
  type        = number
}

variable "ecs_memory_saturation_alarm_threshold" {
  description = "Average ECS service memory utilization percentage treated as saturation."
  type        = number
}

output "alarm_names" {
  value = [
    aws_cloudwatch_metric_alarm.alb_unhealthy_targets.alarm_name,
    aws_cloudwatch_metric_alarm.target_5xx.alarm_name,
    aws_cloudwatch_metric_alarm.ecs_cpu_saturation.alarm_name,
    aws_cloudwatch_metric_alarm.ecs_memory_saturation.alarm_name
  ]
}
