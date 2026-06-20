# AWS Containerized Web App

This repository is a compact reference project for running a containerized web application on AWS using ECS Fargate, an Application Load Balancer, private subnets, and EFS shared storage.

The configuration is intentionally compact so the infrastructure relationships are easy to inspect. It is a baseline deployment, not a complete container platform.

## Use Case

This project represents a small web application or internal service that runs as a container behind a load balancer while keeping ECS tasks in private subnets.

Realistic examples include a simple backend web service, admin tool, or content-serving application where the ALB handles public HTTP routing and EFS provides shared file storage across task replacements.

## What This Lab Demonstrates

- Running a container task on AWS Fargate
- Routing public HTTP traffic through an Application Load Balancer
- Placing ECS tasks in private subnets
- Mounting Amazon EFS into containers through an access point
- Using Terraform modules to separate VPC, ALB, EFS, and ECS concerns
- Identifying trade-offs around public access, shared storage, and network cost

## Architecture Overview

![Containerized Web App Diagram](diagram/containerized-web-app.png)

The Terraform configuration creates a VPC with public and private subnets, an internet-facing ALB, an ECS Fargate service, and an EFS file system mounted into the task. The ALB listens on HTTP port 80 and forwards requests to the Fargate task.

Runtime request flow:

- A user request reaches the public ALB.
- The ALB forwards the request to the ECS target group.
- A Fargate task serves the application from private subnets.
- The task can mount EFS when shared persistent files are needed.
- Container logs are sent to CloudWatch Logs for basic runtime inspection.

The ECS service uses a fixed desired count. Autoscaling is not currently implemented. Basic deployment rollback and ALB target health behavior are configured.

## AWS Services Used

| Service | Role in this lab |
| --- | --- |
| Amazon VPC | Provides public and private networking |
| Amazon ECS | Runs the container service |
| AWS Fargate | Provides serverless container compute |
| Elastic Load Balancing | Routes HTTP traffic to ECS tasks |
| Amazon EFS | Provides shared persistent file storage |
| AWS IAM | Provides ECS task execution and task roles |
| Amazon CloudWatch Logs | Stores ECS task container logs |

## What Terraform Creates

The Terraform configuration provisions:

- VPC with public and private subnets
- NAT gateway for private subnet outbound access, which creates standing hourly cost while deployed
- Application Load Balancer and target group
- ECS cluster, task definition, and service
- EFS file system, mount targets, and access point
- Security groups for ALB, ECS, and EFS
- IAM roles for ECS task execution and task permissions
- CloudWatch log group for ECS task logs

## Repository Layout

| Path | Purpose |
| --- | --- |
| `main.tf` | Root Terraform wiring for VPC, EFS, ALB, and ECS modules |
| `variables.tf` | Region and container image inputs |
| `app/` | Minimal TypeScript sample app and Dockerfile |
| `.github/workflows/ci.yml` | GitHub Actions workflow for app, container, and Terraform validation |
| `modules/vpc/` | VPC, subnets, and NAT gateway |
| `modules/alb/` | ALB, listener, target group, and ALB security group |
| `modules/ecs-fargate/` | ECS cluster, task definition, service, and IAM roles |
| `modules/efs/` | EFS file system, mount targets, access point, and security group |
| `diagram/` | Architecture diagram |
| `images/` | Demo screenshots |

## How To Deploy

Prerequisites:

- AWS credentials configured locally
- Terraform installed
- A region where the selected services are available

Deploy:

```bash
terraform init
terraform plan
terraform apply
terraform output alb_dns_name
```

Open the ALB DNS name in a browser after the service is healthy.

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

Terraform deployment still uses the configured `container_image` value and the existing nginx/EFS path. Wiring this sample image into ECS, adding ECR, and publishing immutable image tags are left for a later batch. AWS runtime validation remains pending until the infrastructure is aligned and deployed.

Use an explicit image tag or immutable digest for `container_image`, such as `nginx:1.27-alpine` or an image reference ending in `@sha256:...`. The local app Dockerfile can be used to build an owned image, but ECS still runs the configured image until image publishing and wiring are added later.

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

Review the destroy plan before confirming. EFS, load balancers, NAT gateways, and CloudWatch resources can continue to create cost if left behind.

## Security Notes

- The ALB listener is public HTTP on port 80 for learning/demo purposes. Real deployments should add HTTPS with ACM, redirect HTTP to HTTPS, and review security controls.
- ECS task ingress is limited to the ALB security group.
- EFS NFS ingress is limited to the ECS task security group.
- Outbound egress is broad in the demo security groups.
- No authentication or application-layer authorization is implemented.

## Cost Notes

Potential standing cost drivers include:

- NAT gateway hourly charges and data processing
- Application Load Balancer hourly charges
- Fargate task runtime
- EFS storage and throughput
- CloudWatch Logs storage and ingestion

Destroy the stack after testing if you do not need it running.

## Limitations

- No ECS service autoscaling is configured.
- The ALB uses HTTP, not HTTPS.
- No custom domain or certificate is configured.
- The task definition uses a simple container image input and a bootstrap container to seed basic content.
- The CI workflow validates changes but does not publish container images or deploy to AWS.
- Observability is limited to ECS task logs and ALB target health checks.
- IAM and security group rules should be reviewed before using this pattern outside a learning or sandbox account.

## Architecture Trade-offs

- ECS Fargate reduces compute management compared with self-managed container hosts, but gives less control over the underlying runtime environment.
- A public ALB with private ECS tasks keeps task networking private while still exposing HTTP entry points.
- EFS supports shared persistent files across task replacements, but stateless containers are simpler to scale and operate.
- A NAT gateway simplifies private subnet outbound access, but it adds standing cost.
- The compact Terraform structure is easier to inspect, but it does not include the controls expected from a complete container platform.

## Next Improvements

- Add HTTPS listener support with ACM.
- Add CloudWatch metrics and alarms for ECS and ALB signals.
- Add ECS service autoscaling policies.
- Add an image publishing path for the sample app, such as an ECR-backed workflow with immutable image tags.

## Project Maturity

Maturity: Basic / baseline reference project.

This repo is useful for discussing Fargate networking, ALB routing, and EFS trade-offs. It needs additional security, operational, and deployment controls before it should be adapted for real workloads.

## Related Reference Hub

This project is part of my AWS Backend Architecture Reference Hub, which connects backend-focused AWS architecture projects, infrastructure-as-code practice, and engineering trade-offs.

[AWS Architecture Labs](https://github.com/hongzz0618/aws-architecture-labs)
