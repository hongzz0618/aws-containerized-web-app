# Container Image Deployment Runbook

This runbook describes the controlled manual path for publishing the CI-validated application image to the Terraform-managed private ECR repository and then supplying ECS with an immutable image digest.

The release workflow is intentionally manual in this phase. CI validates the application and container build without AWS credentials. The separate `Release Container Image` workflow requires GitHub Environment approval, uses GitHub OIDC for short-lived AWS credentials, pushes an immutable image tag to ECR, and does not deploy ECS.

## Prerequisites

- Terraform installed.
- Current Git commit available locally.
- Permissions to create and manage this repository's VPC, ALB, ECS, IAM, CloudWatch Logs, and ECR resources.
- A selected AWS region that matches `var.aws_region`.
- An existing account-level GitHub Actions OIDC provider for `https://token.actions.githubusercontent.com`.
- Permission to create and configure GitHub repository environments and variables.

Do not store AWS access keys, Docker tokens, ECR login output, OIDC tokens, or temporary session credentials in this repository or in GitHub secrets. The release workflow uses OIDC instead of long-lived AWS credentials.

## Account-Level GitHub OIDC Provider

The GitHub OIDC provider is an AWS account-level shared resource. This application stack does not create `aws_iam_openid_connect_provider`, because doing so can conflict with an existing account-wide provider.

Before enabling the release role, confirm that the selected AWS account has an OIDC provider with:

- Provider URL: `https://token.actions.githubusercontent.com`
- Audience/client ID: `sts.amazonaws.com`
- Thumbprint: current GitHub Actions OIDC thumbprint per AWS/GitHub guidance

Use the provider ARN as `github_oidc_provider_arn`. It has this shape:

```text
arn:aws:iam::<account-id>:oidc-provider/token.actions.githubusercontent.com
```

When the release role is enabled, Terraform checks that this ARN uses the current AWS partition and caller account ID. A provider from another account, another partition, or any issuer other than `token.actions.githubusercontent.com` is rejected.

## Terraform Release Role Configuration

The optional release role is disabled by default. To create it, set:

```hcl
enable_github_ecr_release_role = true
github_oidc_provider_arn       = "arn:aws:iam::<account-id>:oidc-provider/token.actions.githubusercontent.com"
github_repository              = "hongzz0618/aws-containerized-web-app"
github_release_environment     = "container-release"
```

The role trust policy is intentionally narrow:

```text
aud = sts.amazonaws.com
sub = repo:hongzz0618/aws-containerized-web-app:environment:container-release
```

The subject uses the GitHub Environment form. Do not expect the same OIDC `sub` value to include a branch name. Branch safety is enforced by the workflow rejecting non-`main` refs and by the GitHub Environment deployment branch rule described below.

The IAM role uses AWS's minimum role maximum session duration of 3600 seconds. The release workflow requests a shorter 1800-second OIDC session for each run.

After applying Terraform in a controlled change window, read the values needed by GitHub:

```bash
terraform output -raw github_ecr_release_role_arn
terraform output -raw ecr_repository_name
terraform output -raw ecr_repository_url
```

Workflow and IAM configuration are statically validated in this repository. Live OIDC assumption and ECR publication require Terraform deployment and a manual GitHub Actions run.

## GitHub Environment

Before the first real release run, manually create this GitHub Environment in the repository settings:

```text
container-release
```

Configure it before running the workflow:

- Deployment branches: allow only `main`.
- Required reviewers: enable if the current GitHub plan supports it.
- Solo repositories: verify the plan and environment settings allow the intended reviewer to approve the run.
- Prevent self-review: leave disabled unless another reviewer is available. If enabled, the workflow actor cannot approve their own run.
- Admin bypass: disable or restrict it according to how tightly this repository should enforce approvals.
- Variables: add environment or repository variables, not AWS long-lived secrets.

Required variables:

| Variable | Value |
| --- | --- |
| `AWS_REGION` | AWS region for the ECR repository, for example `eu-west-1` |
| `AWS_ACCOUNT_ID` | 12-digit AWS account ID |
| `AWS_ECR_RELEASE_ROLE_ARN` | `terraform output -raw github_ecr_release_role_arn` |
| `ECR_REPOSITORY_NAME` | `terraform output -raw ecr_repository_name` |

Do not add `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, or `AWS_SESSION_TOKEN`.

If `container-release` does not exist, do not run the workflow just to let GitHub create it implicitly. Create and protect the environment first.

## Manual GitHub Actions Release

Use the Actions page:

1. Select `Release Container Image`.
2. Choose branch `main`.
3. Enter the full 40-character commit SHA from `main` as `confirm_sha`.
4. Start the workflow.
5. Approve the `container-release` environment job when prompted.

The workflow validates:

- it is running from `refs/heads/main`
- `GITHUB_SHA` is a full lowercase 40-character SHA
- `confirm_sha` is a full lowercase 40-character SHA
- `confirm_sha` equals `GITHUB_SHA`
- the checked out commit equals `GITHUB_SHA`

Then it performs this order:

```text
checkout exact SHA
npm ci
typecheck, tests, build, npm audit --omit=dev
build one final image
smoke test the same image
generate SBOM and vulnerability report from the same image
fail on fixable CRITICAL vulnerabilities
assume the ECR release role through OIDC
log in to ECR
fail if git-<sha> already exists
push git-<sha>
query and validate the remote digest
```

The workflow summary includes the source commit, immutable tag, ECR repository, remote digest, digest URI, scan status, and the note that ECS was not updated.

IAM action mapping:

| Workflow command | Required IAM action |
| --- | --- |
| ECR login action | `ecr:GetAuthorizationToken` |
| Docker push layer checks | `ecr:BatchCheckLayerAvailability` |
| Docker layer upload | `ecr:InitiateLayerUpload`, `ecr:UploadLayerPart`, `ecr:CompleteLayerUpload` |
| Docker manifest push | `ecr:PutImage` |
| Duplicate tag check and remote digest lookup | `ecr:DescribeImages` |

The workflow does not run `aws ecr batch-get-image`, pull a remote manifest, or retag a remote manifest, so `ecr:BatchGetImage` is intentionally not granted.

## Duplicate Releases

ECR tags are immutable. If `git-<full-sha>` already exists, the workflow queries the existing digest and fails closed with an explanation. It does not overwrite, delete, retag, skip as success, or switch to a mutable tag.

## Digest Use For Deployment

After a successful release, copy the digest URI from the workflow summary:

```text
<repository-url>@sha256:<64-lowercase-hex-digest>
```

Use that value as `app_image_uri` for a later, separate Terraform deployment. Publishing the image is not an ECS deployment. Do not treat the release workflow as evidence that ECS task definition updates, service rollout, alarms, rollback, or runtime behavior have been live-validated.

Common OIDC failures:

- The AWS OIDC provider ARN does not point to `token.actions.githubusercontent.com`.
- The GitHub Environment name differs from `container-release`.
- The trust policy expects a branch subject instead of `repo:<owner>/<repo>:environment:container-release`.
- The workflow was run from a non-`main` branch.
- The GitHub Environment lacks the `main`-only deployment branch rule.
- Required GitHub variables are missing or use the wrong account, region, repository, or role ARN.

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

## Local Manual Publication Fallback

The GitHub Actions release workflow is the preferred publication path. The following local CLI steps are a fallback for a controlled maintenance case where you intentionally use local AWS credentials and a local Docker daemon. They are not required for the OIDC workflow above.

Fallback prerequisites:

- AWS CLI authenticated for the selected account and region.
- Docker daemon running locally.
- Current Git commit available locally.

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

## CI Container Security Reports

Before publishing an image, review the GitHub Actions run for the commit you plan to release. The CI app job builds one final local image, runs the container smoke test against that image, then generates reports from the same image with Trivy `v0.71.2`. CI does not upload SARIF, push to ECR, or deploy AWS resources.

Download the 14-day `container-security-reports` artifact from the workflow run. It contains:

- `container-sbom.cdx.json`: CycloneDX JSON SBOM for the final image.
- `container-vulnerabilities.json`: Trivy JSON vulnerability report for OS and library findings in the final image.

For a quick local inspection:

```bash
jq '.bomFormat, .metadata.component.name, (.components | length)' artifacts/container-sbom.cdx.json
jq '[.Results[]?.Vulnerabilities[]? | .Severity] | group_by(.) | map({severity: .[0], count: length})' artifacts/container-vulnerabilities.json
```

PowerShell:

```powershell
Get-Content artifacts/container-sbom.cdx.json | ConvertFrom-Json | Select-Object bomFormat
Get-Content artifacts/container-vulnerabilities.json | ConvertFrom-Json | Select-Object -ExpandProperty Results
```

Use the Trivy fields to separate likely sources:

- Base image and OS packages usually appear with Debian package metadata and image layer context.
- Runtime npm dependencies appear as library findings from the installed production dependency tree.
- Dev dependencies should not be treated as runtime container findings unless they are present in the final image.

The current CI gate fails only on fixable CRITICAL vulnerabilities. HIGH findings and unfixed CRITICAL findings still require review before release, but they do not block this initial gate automatically. Do not ignore vulnerabilities only to make CI pass. Any exception should have a clear reason, narrow package or vulnerability scope, an owner, an expiration date, and a tracking issue or ticket. Prefer fixing the base image, OS package, or runtime dependency when a low-risk fix is available.

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
<repository-url>@sha256:<64-lowercase-hex-digest>
```

## Full Terraform Deployment

Set `app_image_uri` to the digest-pinned value:

```hcl
app_image_uri = "<repository-url>@sha256:<64-lowercase-hex-digest>"
```

Then use the normal Terraform workflow:

```bash
terraform plan
terraform apply
```

Do not use tags such as `:latest` or `:git-<sha>` for `app_image_uri`. A digest-pinned image reference makes the ECS task definition resolve to the exact image that was reviewed and pushed.

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
- `app_image_uri` uses `<repository-url>@sha256:<64-lowercase-hex-digest>` and does not use a tag-only reference.
- The digest came from `aws ecr describe-images` for the exact tag.
- The selected AWS region matches the Terraform provider region.

The ECR repository is configured with `force_delete = false`. Terraform cannot destroy a non-empty repository while that setting remains false. Images must be intentionally removed before complete cleanup, which protects stored images from accidental deletion during stack teardown.
