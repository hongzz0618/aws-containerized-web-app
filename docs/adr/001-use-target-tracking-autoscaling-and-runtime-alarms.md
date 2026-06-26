# ADR 001: Use Target Tracking Autoscaling And Runtime Alarms

## Context

The ECS/Fargate reference service previously used a static desired count and basic ECS deployment rollback. That made the runtime easy to inspect, but it left several operational gaps:

- service capacity did not respond to CPU or memory pressure
- Terraform could have reset runtime desired count changes if autoscaling was added without drift handling
- deployment percentage behavior was implicit
- CloudWatch visibility was limited to container logs and ALB target health

This repository remains a compact reference project. The reliability wave should improve service behavior and failure visibility without adding extra routing, security, storage, tracing, or deployment services.

## Decision

Configure ECS Service Application Auto Scaling directly inside the existing ECS module and add a small observability module for focused CloudWatch alarms.

The default service capacity is:

- `service_desired_count = 1`
- `service_min_capacity = 1`
- `service_max_capacity = 3`

These values keep the steady-state reference environment low cost while allowing limited scale-out for load or deployment validation. The maximum is intentionally small to avoid uncontrolled cost growth in a sandbox account.

## CPU And Memory Target Tracking

Two target tracking policies are configured:

- CPU: `ECSServiceAverageCPUUtilization` at 65%
- Memory: `ECSServiceAverageMemoryUtilization` at 75%

Either policy can request scale-out. Scale-in is conservative and only occurs when the target tracking policies agree that capacity can be reduced. During ECS deployments, target tracking scale-in is suspended while scale-out can still occur. Application Auto Scaling uses the resulting capacity recommendations within the configured min/max range; it does not exceed `service_max_capacity`.

CPU and memory are both used because this service could saturate on either compute or memory pressure. Request-count scaling is not configured because the current app has no measured traffic model, no per-request work profile, and no baseline request-per-task target.

Scale-out cooldown is 60 seconds and scale-in cooldown is 300 seconds. Scale-out is more responsive to reduce sustained saturation. Scale-in is slower to avoid capacity flapping after short bursts or after a deployment settles.

## Terraform Desired Count Drift

The ECS service still has an explicit `desired_count` for initial creation. The `service_desired_count` variable seeds the ECS service when it is created. After creation, Application Auto Scaling can change desired count at runtime.

The service uses:

```hcl
lifecycle {
  ignore_changes = [desired_count]
}
```

Only `desired_count` is ignored. Terraform still manages the task definition, load balancer attachment, network configuration, deployment guardrails, and other service settings. This avoids Terraform and Application Auto Scaling fighting over runtime capacity while preserving meaningful drift detection elsewhere.

Autoscaling is always enabled for this reference project. A toggle was not added because conditional lifecycle behavior would add complexity without improving the current reference goal.

## Deployment Guardrails

Rolling deployments explicitly use:

- `deployment_minimum_healthy_percent = 100`
- `deployment_maximum_percent = 200`
- deployment circuit breaker enabled
- automatic rollback enabled
- health check grace period of 60 seconds

For the default single-task service, `100/200` allows ECS to start one replacement task before stopping the old one. That improves availability during deployment but can temporarily run two tasks and increase Fargate cost during the rollout.

ECS deployment alarm rollback is not wired in this project. The deployment circuit breaker and ALB health checks provide the current deployment failure protection. The CloudWatch alarms were reviewed during a controlled AWS deployment and remained in OK state, but they were not exercised as rollback gates or calibrated under workload-specific traffic.

## Runtime Alarms

Four alarms are configured:

- ALB unhealthy targets
- ALB target 5XX count
- ECS CPU saturation
- ECS memory saturation

Unhealthy targets and 5XX responses focus on request-path and container health. CPU and memory saturation thresholds are deliberately above the target tracking values so normal autoscaling activity is not treated as a failure.

All alarms use `treat_missing_data = "notBreaching"` because this reference environment can have low or no traffic. Missing metrics should not page by default.

## Notification Actions

Alarms are created even when no notification actions are supplied. Notification delivery is optional through `alarm_action_arns` and `ok_action_arns`, typically pointing at existing SNS topics.

This wave does not create SNS topics or subscriptions. That avoids hardcoded email addresses, unconfirmed subscriptions, and extra account-level setup.

## Cost Impact

Steady-state capacity is one Fargate task by default. Autoscaling can increase capacity up to three tasks. Rolling deployment can temporarily run replacement tasks within the deployment maximum percentage. With the default desired count of one this can mean two running tasks during deployment; if runtime desired count has already scaled out, the temporary deployment ceiling is based on that higher desired count.

CloudWatch alarms add a small standing cost. No new NAT gateways, databases, storage systems, dashboards, or edge services are added.

## Alternatives Considered

- Request-count target tracking: deferred because there is no measured request-per-task target for this app.
- Fargate Spot: deferred because interruption handling is outside this wave and would change reliability behavior.
- Larger alarm set or dashboard: deferred to keep the signal set focused and avoid unvalidated noise.
- ECS deployment alarm rollback: deferred until alarm thresholds are calibrated under workload-specific traffic and intentionally exercised during rollout-failure testing.
- Autoscaling enable/disable toggle: deferred because always-on autoscaling keeps the reference simpler and avoids conditional lifecycle complexity.

## Validation Status

Terraform formatting, initialization, validation, plan-contract tests, and static regression checks run locally and in CI.

A controlled AWS deployment validated the digest-pinned ECS service, ALB target health, application endpoints, CloudWatch Logs delivery, and the presence and `OK` state of the four runtime alarms. The environment was subsequently destroyed and Terraform state verification reported zero remaining entries.

Real autoscaling scale-out and scale-in behavior, alarm notification delivery, workload-specific threshold calibration, and deployment rollback were not actively exercised during that validation cycle.
