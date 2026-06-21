# AWS Containerized Web App

This repository is a compact reference project for running a containerized Node.js web application on AWS using ECS Fargate, an Application Load Balancer, private subnets, and Terraform.

The configuration is intentionally compact so the infrastructure relationships are easy to inspect. It is a baseline deployment, not a complete container platform.

## Use Case

This project represents a small web application or internal service that runs as a container behind a load balancer while keeping ECS tasks in private subnets.

Realistic examples include a simple backend web service or internal service where the ALB handles public HTTP routing and ECS runs the application container in private subnets.

## What This Lab Demonstrates

- Running a container task on AWS Fargate
- Routing public HTTP traffic through an Application Load Balancer
- Placing ECS tasks in private subnets
- Using Terraform modules to separate VPC, ALB, and ECS concerns
- Identifying trade-offs around public access, private task networking, and network cost

## Architecture Overview

![Containerized Web App Diagram](diagram/containerized-web-app.svg)

The Terraform configuration creates a VPC with public and private subnets, an internet-facing ALB, and an ECS Fargate service. The ALB listens on HTTP port 80 and forwards requests to the Node.js application container on port 3000.

Runtime request flow:

- A user request reaches the public ALB.
- The ALB forwards the request to the ECS target group on port 3000.
- A Fargate task serves the Node.js application from private subnets.
- ALB target health checks call `GET /health`.
- Container logs are sent to CloudWatch Logs for basic runtime inspection.

The ECS service uses a fixed desired count. Autoscaling is not currently implemented. Basic deployment rollback and ALB target health behavior are configured.

## AWS Services Used

| Service | Role in this lab |
| --- | --- |
| Amazon VPC | Provides public and private networking |
| Amazon ECS | Runs the container service |
| AWS Fargate | Provides serverless container compute |
| Amazon ECR | Stores the application image in a private immutable-tag repository |
| Elastic Load Balancing | Routes HTTP traffic to ECS tasks |
| AWS IAM | Provides ECS task execution and task roles |
| Amazon CloudWatch Logs | Stores ECS task container logs |

## What Terraform Creates

The Terraform configuration provisions:

- VPC with public and private subnets
- NAT gateway for private subnet outbound access, which creates standing hourly cost while deployed
- Private ECR repository with immutable tags, scan-on-push, AES256 encryption, and lifecycle retention
- Application Load Balancer and target group
- ECS cluster, task definition, and service
- Security groups for ALB and ECS
- IAM roles for ECS task execution and task permissions
- CloudWatch log group for ECS task logs

## Repository Layout

| Path | Purpose |
| --- | --- |
| `main.tf` | Root Terraform wiring for VPC, ALB, and ECS modules |
| `variables.tf` | Region, naming, application image, and runtime inputs |
| `app/` | Minimal TypeScript sample app and Dockerfile |
| `.github/workflows/ci.yml` | GitHub Actions workflow for app, container, and Terraform validation |
| `docs/deployment-runbook.md` | Manual ECR image publication and digest-pinned deployment workflow |
| `modules/vpc/` | VPC, subnets, and NAT gateway |
| `modules/alb/` | ALB, listener, target group, and ALB security group |
| `modules/ecs-fargate/` | ECS cluster, task definition, service, and IAM roles |
| `modules/ecr/` | Private ECR repository and lifecycle policy |
| `diagram/` | Architecture diagram |
| `images/` | Demo screenshots |

## How To Deploy

Prerequisites:

- AWS credentials configured locally
- Terraform installed
- A digest-pinned application image reference for `app_image_uri`
- A region where the selected services are available

ECR has a bootstrap dependency: the repository must exist before the first image can be pushed, while the full ECS deployment needs an existing image. Use the deployment runbook for the controlled manual publication flow:

[Container Image Deployment Runbook](docs/deployment-runbook.md)

Initial review:

```bash
terraform init
cp terraform.tfvars.example terraform.tfvars
terraform plan
```

After the ECR repository is bootstrapped, publish an immutable `git-<full-commit-sha>` image tag manually, retrieve its digest, set `app_image_uri` to `<repository-url>@sha256:<digest>`, and use a normal Terraform plan/apply. Real AWS runtime validation remains pending until that controlled deployment is performed.

## Local Container App

The `app/` directory contains a small Node.js and TypeScript HTTP service with `GET /`, `GET /health`, and 404 responses for unknown routes. The included Dockerfile builds and runs the compiled service on port 3000.

Validate the app locally:

```bash
cd app
npm ci
npm run typecheck
npm test
npm run build
```

Build the container image:

```bash
docker build -t aws-containerized-web-app-local .
```

Run the container smoke test from `app/` when the Docker daemon is active:

```bash
npm run test:container
```

The smoke test builds the image, starts a temporary container on `127.0.0.1`, runs it with a read-only root filesystem, drops Linux capabilities, enables `no-new-privileges`, checks `GET /health` and `GET /`, verifies the runtime UID is not root, stops the container through Docker, checks shutdown logs, and removes the temporary container.

Terraform manages a private ECR repository for the application image. Repository tags are immutable, scan-on-push is enabled, and a lifecycle policy expires untagged images after 7 days while retaining the newest 10 `git-` tagged images.

CI validates the application container but does not publish images. Image publication remains a manual workflow. ECS still receives the full image reference through `app_image_uri`; use a digest-pinned ECR reference such as `<repository-url>@sha256:<digest>` after following the runbook.

## CI Validation

This repository includes a GitHub Actions CI workflow for local-style validation. The workflow:

- Installs the sample app dependencies with `npm ci`
- Typechecks, builds, and tests the TypeScript app
- Builds the sample app Docker image and runs the container smoke test
- Runs `terraform fmt -check -recursive`
- Runs `terraform init -backend=false -input=false`
- Runs `terraform validate -no-color`

The workflow validates the application, container build, and Terraform configuration. It does not deploy resources to AWS.

## How To Clean Up

```bash
terraform destroy
```

Review the destroy plan before confirming. Load balancers, NAT gateways, Fargate tasks, and CloudWatch resources can continue to create cost if left behind.

The ECR repository uses `force_delete = false`. Terraform cannot destroy a non-empty repository while this setting remains false; remove images intentionally before complete cleanup. This protects stored images from accidental deletion.

## Security Notes

- The ALB listener is public HTTP on port 80 for learning/demo purposes. Real deployments should add HTTPS with ACM, redirect HTTP to HTTPS, and review security controls.
- ECS task ingress is limited to the ALB security group.
- The ECS task definition enables a read-only root filesystem and drops Linux capabilities. ECS task definitions do not expose a direct `no-new-privileges` setting equivalent to the local Docker smoke test.
- The execution role is used for ECS startup operations such as pulling the image and writing logs. The task role has no additional application policies because the app does not call AWS APIs.
- Private ECS tasks continue to use NAT for outbound access, including image pulls and service calls.
- Outbound egress is broad in the demo security groups.
- No authentication or application-layer authorization is implemented.

## Cost Notes

Potential standing cost drivers include:

- NAT gateway hourly charges and data processing
- Application Load Balancer hourly charges
- Fargate task runtime
- CloudWatch Logs storage and ingestion

Destroy the stack after testing if you do not need it running.

## Limitations

- No ECS service autoscaling is configured.
- The ALB uses HTTP, not HTTPS.
- No custom domain or certificate is configured.
- ECR image publication is manual; CI does not push images or deploy to AWS.
- The ECS task uses `PORT=3000` and `SHUTDOWN_TIMEOUT_MS=10000`. ECS `stopTimeout` is set to 15 seconds, and the ALB target group deregistration delay is set to 30 seconds.
- The CI workflow validates changes but does not publish container images or deploy to AWS.
- Observability is limited to ECS task logs and ALB target health checks.
- IAM and security group rules should be reviewed before using this pattern outside a learning or sandbox account.

## Architecture Trade-offs

- ECS Fargate reduces compute management compared with self-managed container hosts, but gives less control over the underlying runtime environment.
- A public ALB with private ECS tasks keeps task networking private while still exposing HTTP entry points.
- A NAT gateway simplifies private subnet outbound access, but it adds standing cost.
- The compact Terraform structure is easier to inspect, but it does not include the controls expected from a complete container platform.

## Next Improvements

- Add HTTPS listener support with ACM.
- Add CloudWatch metrics and alarms for ECS and ALB signals.
- Add ECS service autoscaling policies.
- Perform a controlled AWS deployment and capture runtime validation evidence.

## Project Maturity

Maturity: Basic / baseline reference project.

This repo is useful for discussing Fargate networking, ALB routing, container health checks, and image deployment trade-offs. It needs additional security, operational, and deployment controls before it should be adapted for real workloads.

## Related Reference Hub

This project is part of my AWS Backend Architecture Reference Hub, which connects backend-focused AWS architecture projects, infrastructure-as-code practice, and engineering trade-offs.

[AWS Architecture Labs](https://github.com/hongzz0618/aws-architecture-labs)
