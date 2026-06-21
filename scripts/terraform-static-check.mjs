#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const root = new URL("..", import.meta.url);

function read(path) {
  return readFileSync(new URL(path, root), "utf8");
}

function terraformFiles(dir = ".") {
  const absoluteDir = new URL(dir, root);
  return readdirSync(absoluteDir, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = dir === "." ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === ".terraform" || entry.name === ".git") {
        return [];
      }
      return terraformFiles(relativePath);
    }
    return entry.isFile() && entry.name.endsWith(".tf") ? [relativePath] : [];
  });
}

function assertIncludes(content, expected, label) {
  assert(content.includes(expected), `${label} is missing ${JSON.stringify(expected)}`);
}

function assertMatches(content, pattern, label) {
  assert(pattern.test(content), `${label} does not match ${pattern}`);
}

const main = read("main.tf");
const variables = read("variables.tf");
const ecs = read("modules/ecs-fargate/main.tf");
const alb = read("modules/alb/main.tf");
const observability = read("modules/observability/main.tf");
const terraform = terraformFiles()
  .map((path) => read(path))
  .join("\n");

assertIncludes(ecs, 'resource "aws_appautoscaling_target" "ecs_service"', "autoscaling target");
assertIncludes(ecs, 'resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.this.name}"', "autoscaling resource id");
assertIncludes(ecs, 'scalable_dimension = "ecs:service:DesiredCount"', "autoscaling scalable dimension");
assertIncludes(ecs, 'service_namespace  = "ecs"', "autoscaling service namespace");
assertIncludes(ecs, "min_capacity       = var.min_capacity", "autoscaling min capacity");
assertIncludes(ecs, "max_capacity       = var.max_capacity", "autoscaling max capacity");
assertIncludes(ecs, '"ECSServiceAverageCPUUtilization"', "CPU target tracking policy");
assertIncludes(ecs, '"ECSServiceAverageMemoryUtilization"', "memory target tracking policy");
assert(!ecs.includes("disable_scale_in"), "target tracking scale-in must not be disabled");
assertIncludes(ecs, "ignore_changes = [desired_count]", "desired count drift protection");
assert(!ecs.includes("ignore_changes = all"), "ECS service must not ignore all Terraform drift");

assertMatches(ecs, /deployment_minimum_healthy_percent\s*=\s*var\.deployment_minimum_healthy_percent/, "minimum healthy percent");
assertMatches(ecs, /deployment_maximum_percent\s*=\s*var\.deployment_maximum_percent/, "maximum percent");
assertMatches(ecs, /deployment_circuit_breaker\s*{\s*enable\s*=\s*true\s*rollback\s*=\s*true\s*}/s, "deployment circuit breaker rollback");
assertMatches(ecs, /health_check_grace_period_seconds\s*=\s*var\.health_check_grace_period_seconds/, "health check grace period");
assertIncludes(ecs, "desired_count must be within min_capacity and max_capacity.", "desired/min/max precondition");
assertIncludes(ecs, "deployment_maximum_percent must be greater than or equal to deployment_minimum_healthy_percent.", "deployment percentage precondition");
assertIncludes(ecs, "min_capacity must be less than or equal to max_capacity.", "min/max capacity precondition");

assertMatches(variables, /variable "service_desired_count"[\s\S]*?default\s*=\s*1/, "default desired count");
assertMatches(variables, /variable "service_min_capacity"[\s\S]*?default\s*=\s*1/, "default min capacity");
assertMatches(variables, /variable "service_max_capacity"[\s\S]*?default\s*=\s*3/, "default max capacity");
assertIncludes(variables, "check \"service_capacity\"", "capacity relationship check");
assertIncludes(variables, "check \"deployment_percentages\"", "deployment percentage relationship check");

assertMatches(main, /desired_count\s*=\s*var\.service_desired_count/, "root desired count wiring");
assertMatches(main, /min_capacity\s*=\s*var\.service_min_capacity/, "root min capacity wiring");
assertMatches(main, /max_capacity\s*=\s*var\.service_max_capacity/, "root max capacity wiring");
assertIncludes(alb, "aws_lb.this.arn_suffix", "ALB ARN suffix output");
assertIncludes(alb, "aws_lb_target_group.this.arn_suffix", "target group ARN suffix output");

const alarmCount = (observability.match(/resource "aws_cloudwatch_metric_alarm"/g) || []).length;
assert.equal(alarmCount, 4, "runtime alarm count should stay focused at four alarms");
assertIncludes(observability, 'metric_name         = "UnHealthyHostCount"', "unhealthy target alarm metric");
assertIncludes(observability, 'metric_name         = "HTTPCode_Target_5XX_Count"', "target 5XX alarm metric");
assertIncludes(observability, 'metric_name         = "CPUUtilization"', "ECS CPU alarm metric");
assertIncludes(observability, 'metric_name         = "MemoryUtilization"', "ECS memory alarm metric");
assertIncludes(observability, "LoadBalancer = var.load_balancer_arn_suffix", "ALB alarm load balancer dimension");
assertIncludes(observability, "TargetGroup  = var.target_group_arn_suffix", "ALB alarm target group dimension");
assertIncludes(observability, "ClusterName = var.ecs_cluster_name", "ECS alarm cluster dimension");
assertIncludes(observability, "ServiceName = var.ecs_service_name", "ECS alarm service dimension");
assertIncludes(observability, 'treat_missing_data  = "notBreaching"', "alarm missing-data behavior");
assertIncludes(observability, "alarm_actions       = var.alarm_action_arns", "optional alarm actions");
assertIncludes(observability, "ok_actions          = var.ok_action_arns", "optional OK actions");
assert(!observability.includes("insufficient_data_actions"), "alarms should not send insufficient-data notifications by default");

const releaseIam = read("release-iam.tf");
assertIncludes(releaseIam, 'count = var.enable_github_ecr_release_role ? 1 : 0', "release role feature flag");
assertIncludes(releaseIam, 'actions = ["sts:AssumeRoleWithWebIdentity"]', "GitHub OIDC trust action");
assertIncludes(releaseIam, 'type        = "Federated"', "GitHub OIDC federated principal");
assertIncludes(releaseIam, "token.actions.githubusercontent.com:aud", "GitHub OIDC audience condition");
assertIncludes(releaseIam, 'values   = ["sts.amazonaws.com"]', "GitHub OIDC audience value");
assertIncludes(releaseIam, "token.actions.githubusercontent.com:sub", "GitHub OIDC subject condition");
assertIncludes(releaseIam, 'repo:${trimspace(var.github_repository)}:environment:${trimspace(var.github_release_environment)}', "GitHub environment subject");
assert(!releaseIam.includes("StringLike"), "GitHub OIDC trust must not use wildcard subject matching");
assert(!releaseIam.includes("sts:AssumeRole\""), "release role must not allow ordinary sts:AssumeRole");
assertIncludes(releaseIam, "max_session_duration = 3600", "release role max session duration uses the AWS minimum");
assertIncludes(releaseIam, "resources = [module.ecr.repository_arn]", "release policy single ECR repository scope");
assertIncludes(releaseIam, 'actions   = ["ecr:GetAuthorizationToken"]', "ECR auth token permission");
assertIncludes(releaseIam, 'resources = ["*"]', "ECR auth token wildcard resource");
assert(!releaseIam.includes("ecr:*"), "release policy must not allow ecr:*");
assert(!releaseIam.includes("ecs:"), "release policy must not include ECS permissions");
assert(!releaseIam.includes("iam:"), "release policy must not include IAM write permissions");
assert(!releaseIam.includes("s3:"), "release policy must not include S3 permissions");
assert(!releaseIam.includes("cloudwatch:"), "release policy must not include CloudWatch write permissions");
assertIncludes(variables, 'default     = "container-release"', "default release environment");
assertIncludes(variables, 'check "github_ecr_release_role"', "release role variable relationship check");
assertIncludes(main, 'output "github_ecr_release_role_arn"', "release role output");
assertIncludes(main, "try(aws_iam_role.github_ecr_release[0].arn, null)", "safe release role output when disabled");

const forbiddenResources = [
  "aws_sns_topic",
  "aws_sns_topic_subscription",
  "aws_wafv2_web_acl",
  "aws_cloudfront_distribution",
  "aws_route53_record",
  "aws_acm_certificate",
  "aws_nat_gateway",
  "aws_eks_cluster",
  "aws_efs_file_system"
];
for (const resource of forbiddenResources) {
  if (resource === "aws_nat_gateway") {
    assert(!observability.includes(resource) && !ecs.includes(resource), "this wave must not add NAT resources outside the existing VPC module");
    continue;
  }
  assert(!terraform.includes(resource), `forbidden high-scope resource found: ${resource}`);
}

assert(!/Resource\s*=\s*"\*"/.test(terraform), "Terraform must not add IAM Resource wildcard policies");
const wildcardResourceMatches = terraform.match(/resources\s*=\s*\[\s*"\*"\s*\]/gi) || [];
assert.equal(wildcardResourceMatches.length, 1, "Only ecr:GetAuthorizationToken may use an IAM wildcard resource");
assertMatches(
  terraform,
  /actions\s*=\s*\[\s*"ecr:GetAuthorizationToken"\s*\]\s*resources\s*=\s*\[\s*"\*"\s*\]/s,
  "ECR authorization token must be the only wildcard-resource permission"
);

console.log("Terraform static regression checks passed.");
