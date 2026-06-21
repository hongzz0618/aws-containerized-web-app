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

## Verification And Cleanup Preview

Before applying the full configuration, check:

- ECR image metadata for the expected `git-<full-sha>` tag.
- `app_image_uri` uses `@sha256:` and does not use `latest`.
- The digest came from `aws ecr describe-images` for the exact tag.
- The selected AWS region matches the Terraform provider region.

The ECR repository is configured with `force_delete = false`. Terraform cannot destroy a non-empty repository while that setting remains false. Images must be intentionally removed before complete cleanup, which protects stored images from accidental deletion during stack teardown.
