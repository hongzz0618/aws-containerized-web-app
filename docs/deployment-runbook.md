# Container Image Deployment Runbook

This runbook describes the controlled manual path for publishing the CI-validated application image to the Terraform-managed private ECR repository and then supplying ECS with an immutable image digest.

The workflow is intentionally manual in this phase. CI validates the application and container build, but it does not authenticate to AWS, push images, or deploy ECS.

## Prerequisites

- AWS CLI authenticated for the selected account and region.
- Docker daemon running locally.
- Terraform installed.
- Current Git commit available locally.
- Permissions to create and manage this repository's VPC, ALB, ECS, IAM, CloudWatch Logs, and ECR resources.
- A selected AWS region that matches `var.aws_region`.

Do not store AWS credentials, Docker tokens, or ECR login output in this repository.

## Repository Bootstrap

ECR must exist before the first application image can be pushed. A full ECS deployment also needs an image that already exists. Use a one-time targeted apply only to create the repository:

```bash
terraform init
terraform plan -target=module.ecr
terraform apply -target=module.ecr
```

The targeted apply is only for the initial repository bootstrap. It is not the normal long-term Terraform workflow. After the image digest is available, use a normal `terraform plan` and `terraform apply` to reconcile the full configuration.

`app_image_uri` remains a required variable. If Terraform asks for it during bootstrap, provide a syntactically valid placeholder that is not used by the targeted ECR apply, for example:

```hcl
app_image_uri = "000000000000.dkr.ecr.eu-west-1.amazonaws.com/example-app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
```

Read the repository URL after bootstrap:

```bash
ECR_REPOSITORY_URL="$(terraform output -raw ecr_repository_url)"
```

PowerShell:

```powershell
$EcrRepositoryUrl = terraform output -raw ecr_repository_url
```

## Image Tag

Use the full 40-character Git commit SHA as the immutable image tag source.

Bash:

```bash
GIT_SHA="$(git rev-parse HEAD)"
IMAGE_TAG="git-${GIT_SHA}"
```

PowerShell:

```powershell
$GitSha = git rev-parse HEAD
$ImageTag = "git-$GitSha"
```

Do not use a short SHA for the ECR image tag.

## ECR Login

Use `aws ecr get-login-password` and pipe the token directly to Docker. Do not print or store the token.

Bash:

```bash
AWS_REGION="eu-west-1"
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "${ECR_REPOSITORY_URL%/*}"
```

PowerShell:

```powershell
$AwsRegion = "eu-west-1"
aws ecr get-login-password --region $AwsRegion |
  docker login --username AWS --password-stdin ($EcrRepositoryUrl -replace "/.*$", "")
```

## Build

Use the same Dockerfile and build context validated by CI.

Bash:

```bash
cd app
docker build -t "aws-containerized-web-app:${IMAGE_TAG}" .
cd ..
```

PowerShell:

```powershell
Set-Location app
docker build -t "aws-containerized-web-app:$ImageTag" .
Set-Location ..
```

## Push

Tag the local image with the ECR repository URL and immutable `git-<full-sha>` tag, then push it.

Bash:

```bash
docker tag "aws-containerized-web-app:${IMAGE_TAG}" "${ECR_REPOSITORY_URL}:${IMAGE_TAG}"
docker push "${ECR_REPOSITORY_URL}:${IMAGE_TAG}"
```

PowerShell:

```powershell
docker tag "aws-containerized-web-app:$ImageTag" "$EcrRepositoryUrl`:$ImageTag"
docker push "$EcrRepositoryUrl`:$ImageTag"
```

The ECR repository uses immutable tags. Pushing the same `git-<full-sha>` tag again should fail instead of replacing the existing image.

## Retrieve The Digest

Retrieve the digest for the exact immutable tag from ECR. Do not rely only on Docker push output.

Bash:

```bash
IMAGE_DIGEST="$(aws ecr describe-images \
  --region "$AWS_REGION" \
  --repository-name "$(terraform output -raw ecr_repository_name)" \
  --image-ids imageTag="$IMAGE_TAG" \
  --query 'imageDetails[0].imageDigest' \
  --output text)"

APP_IMAGE_URI="${ECR_REPOSITORY_URL}@${IMAGE_DIGEST}"
printf '%s\n' "$APP_IMAGE_URI"
```

PowerShell:

```powershell
$ImageDigest = aws ecr describe-images `
  --region $AwsRegion `
  --repository-name (terraform output -raw ecr_repository_name) `
  --image-ids imageTag=$ImageTag `
  --query 'imageDetails[0].imageDigest' `
  --output text

$AppImageUri = "$EcrRepositoryUrl@$ImageDigest"
$AppImageUri
```

The resulting value has this shape:

```text
<repository-url>@sha256:<64-hex-digest>
```

## Full Terraform Deployment

Set `app_image_uri` to the digest-pinned value:

```hcl
app_image_uri = "<repository-url>@sha256:<64-hex-digest>"
```

Then use the normal Terraform workflow:

```bash
terraform plan
terraform apply
```

Do not use `:latest`. A digest-pinned image reference makes the ECS task definition resolve to the exact image that was reviewed and pushed.

## Autoscaling Verification

After a controlled deployment, verify the ECS service scaling configuration before running any load test:

```bash
aws application-autoscaling describe-scalable-targets \
  --service-namespace ecs \
  --resource-ids "service/<cluster-name>/<service-name>"

aws application-autoscaling describe-scaling-policies \
  --service-namespace ecs \
  --resource-id "service/<cluster-name>/<service-name>"

aws ecs describe-services \
  --cluster "<cluster-name>" \
  --services "<service-name>" \
  --query 'services[0].{desired:desiredCount,running:runningCount,pending:pendingCount,events:events[0:5]}'
```

Confirm:

- the scalable target uses the expected `MinCapacity` and `MaxCapacity`
- CPU and memory target tracking policies exist
- desired, running, and pending task counts are reasonable
- recent ECS service events do not show repeated placement, health check, or rollback failures
- scaling activity history matches any expected capacity changes

Autoscaling can change ECS desired count at runtime. Terraform intentionally ignores only `desired_count` drift on the ECS service so a later `terraform apply` does not reset capacity that Application Auto Scaling selected.

Either CPU or memory target tracking can request scale-out. Scale-in is conservative and only proceeds when the target tracking policies agree capacity can be reduced. During ECS deployments, target tracking scale-in is suspended while scale-out can still occur, subject to `service_max_capacity`.

## Controlled Scale-Out Validation

Do not use production traffic to validate autoscaling. Use a short, controlled test window in a sandbox account:

- record current desired, running, and pending task counts
- generate CPU or memory pressure against the test service for a short duration
- watch scaling activities and ECS service events
- stop the load source explicitly
- verify scale-out happens within `service_max_capacity`
- verify scale-in after the longer cooldown and when utilization drops

Keep the test small. The default maximum is three tasks, but any increase still creates Fargate runtime cost.

## Deployment Failure Diagnosis

If a deployment fails or rolls back, check in this order:

1. ECS service events for deployment circuit breaker messages, task launch failures, and target registration failures.
2. Stopped task reason and container exit code for the failed task definition revision.
3. ALB target health reason for the target group.
4. CloudWatch Logs for startup errors, shutdown signal handling, and forced shutdown messages.
5. The previous task definition revision and image digest.

Circuit breaker rollback should move the service back to the last stable task set when ECS cannot reach steady state. If the new task starts but later returns application errors, use the target 5XX alarm and logs to decide whether to roll back the image digest.

## Alarm Diagnosis

| Alarm | Meaning | First checks | Deployment noise | Response |
| --- | --- | --- | --- | --- |
| ALB unhealthy targets | One or more registered ECS targets stayed unhealthy for the evaluation window | Target health reason, ECS service events, container startup logs, `/health` behavior | A brief transition can occur while replacement tasks register; sustained ALARM is not expected | Roll back if new tasks cannot pass health checks |
| ALB target 5XX | The application container returned repeated 5XX responses through the ALB | App logs, recent image digest, request path, container errors | Low traffic should not create data; a short burst may clear if caused by startup timing | Roll back if tied to a new revision and errors continue |
| ECS CPU saturation | Average service CPU stayed well above the autoscaling target | Scaling activity, desired count versus max capacity, request pattern | Normal scale-out may briefly raise utilization before new tasks are ready | Observe if scale-out catches up; raise capacity only after cost review |
| ECS memory saturation | Average service memory stayed well above the autoscaling target | Container memory usage, restart events, logs, desired count versus max capacity | Startup memory spikes can settle; sustained ALARM needs investigation | Roll back if tied to a memory regression |

Alarms only send notifications when `alarm_action_arns` or `ok_action_arns` are configured with existing action ARNs. Empty action lists still create alarms for console and metric inspection but do not send notifications.

## Cost Notes

- Default steady state is one Fargate task.
- Autoscaling can increase service capacity up to `service_max_capacity`.
- Rolling deployment with `100/200` percentages can temporarily double the current desired count. For the default single-task service that means up to two tasks; if autoscaling has already raised desired count to three, deployment can temporarily allow more replacement capacity.
- The existing NAT gateway can remain the main fixed cost while the stack is deployed.
- CloudWatch alarms have low standing cost, but they are not free.

## Verification And Cleanup Preview

Before applying the full configuration, check:

- ECR image metadata for the expected `git-<full-sha>` tag.
- `app_image_uri` uses `@sha256:` and does not use `latest`.
- The digest came from `aws ecr describe-images` for the exact tag.
- The selected AWS region matches the Terraform provider region.

The ECR repository is configured with `force_delete = false`. Terraform cannot destroy a non-empty repository while that setting remains false. Images must be intentionally removed before complete cleanup, which protects stored images from accidental deletion during stack teardown.
