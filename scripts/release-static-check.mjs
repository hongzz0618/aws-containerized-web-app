#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(".github/workflows/release-container-image.yml", "utf8");
const releaseIam = readFileSync("release-iam.tf", "utf8");
const variables = readFileSync("variables.tf", "utf8");
const main = readFileSync("main.tf", "utf8");
const onBlock = workflow.slice(workflow.indexOf("on:"), workflow.indexOf("\npermissions:"));

function assertIncludes(content, expected, label) {
  assert(content.includes(expected), `${label} is missing ${JSON.stringify(expected)}`);
}

function assertNotIncludes(content, unexpected, label) {
  assert(!content.includes(unexpected), `${label} must not include ${JSON.stringify(unexpected)}`);
}

function assertMatches(content, pattern, label) {
  assert(pattern.test(content), `${label} does not match ${pattern}`);
}

function countMatches(content, pattern) {
  return (content.match(pattern) || []).length;
}

function stepBlock(name) {
  const pattern = new RegExp(`\\n\\s+- name: ${name}\\n([\\s\\S]*?)(?=\\n\\s+- name: |\\n\\s{2}[a-zA-Z0-9_-]+:|\\n?$)`);
  const match = workflow.match(pattern);
  assert(match, `release workflow step missing: ${name}`);
  return match[0];
}

assertIncludes(workflow, "on:\n  workflow_dispatch:", "release trigger");
for (const trigger of ["push:", "pull_request:", "schedule:", "workflow_run:", "release:"]) {
  assertNotIncludes(onBlock, trigger, "release workflow triggers");
}

assertIncludes(workflow, "confirm_sha:", "release confirmation input");
assertNotIncludes(workflow, "image_tag:", "release workflow inputs");
assertNotIncludes(workflow, "dockerfile:", "release workflow inputs");
assertNotIncludes(workflow, "build_context:", "release workflow inputs");
assertNotIncludes(workflow, "role_arn:", "release workflow inputs");

assertIncludes(workflow, "permissions:\n  contents: read", "workflow permissions");
assertIncludes(workflow, "permissions:\n      contents: read\n      id-token: write", "release job permissions");
assert.equal(countMatches(workflow, /id-token: write/g), 1, "id-token write should only be granted to the release job");
for (const permission of ["packages: write", "security-events: write", "pull-requests: write", "actions: write", "deployments: write", "write-all"]) {
  assertNotIncludes(workflow, permission, "release permissions");
}

assertIncludes(workflow, "environment: container-release", "release environment");
assertIncludes(workflow, "group: container-image-release", "release concurrency group");
assertIncludes(workflow, "cancel-in-progress: false", "release concurrency behavior");
assertIncludes(workflow, "RELEASE_IMAGE_REF: aws-containerized-web-app:release-${{ github.sha }}", "local release image reference");
assertIncludes(workflow, "IMAGE_TAG: git-${{ github.sha }}", "immutable image tag");
assertNotIncludes(workflow, ":latest", "release image references");
assertNotIncludes(workflow, "IMAGE_TAG: latest", "release image tag");

const validateRequest = stepBlock("Validate release request");
assertIncludes(validateRequest, '"refs/heads/main"', "main branch guard");
assertIncludes(validateRequest, 'CONFIRM_SHA: ${{ inputs.confirm_sha }}', "confirm SHA environment");
assertMatches(validateRequest, /\^\[0-9a-f\]\{40\}\$/, "full SHA validation");
assertIncludes(validateRequest, '"${CONFIRM_SHA}" != "${GITHUB_SHA}"', "confirm SHA equality guard");

const checkoutStep = stepBlock("Check out repository");
const actionPins = new Map([
  ["actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.1", "checkout action"],
  ["actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0", "setup-node action"],
  ["aquasecurity/setup-trivy@81e514348e19b6112ce2a7e3ecbafe19c1e1f567 # v0.3.1", "setup-trivy action"],
  ["actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2", "upload-artifact action"],
  ["aws-actions/configure-aws-credentials@7474bc4690e29a8392af63c5b98e7449536d5c3a # v4.3.1", "configure AWS credentials action"],
  ["aws-actions/amazon-ecr-login@d539f0932e70871a027e9d5a9d8fc38589180a64 # v2.1.6", "ECR login action"]
]);
for (const [pin, label] of actionPins) {
  assertIncludes(workflow, `uses: ${pin}`, label);
}
assertIncludes(checkoutStep, "ref: ${{ github.sha }}", "checkout exact SHA");
assert.equal(countMatches(workflow, /uses: [^\n]+@[0-9a-f]{40} # v/g), actionPins.size, "all release actions should use full SHA pins with version comments");
assertNotIncludes(workflow, "uses: actions/checkout@v", "floating checkout action");
assertNotIncludes(workflow, "uses: actions/setup-node@v", "floating setup-node action");
assertNotIncludes(workflow, "uses: actions/upload-artifact@v", "floating upload-artifact action");
assertNotIncludes(workflow, "uses: aws-actions/configure-aws-credentials@v", "floating AWS credentials action");
assertNotIncludes(workflow, "uses: aws-actions/amazon-ecr-login@v", "floating ECR login action");

const verifyCheckout = stepBlock("Verify checked out commit");
assertIncludes(verifyCheckout, 'git rev-parse HEAD', "checkout verification");
assertIncludes(verifyCheckout, '"${checked_out_sha}" != "${GITHUB_SHA}"', "checkout SHA guard");

assertIncludes(workflow, "node-version: \"24\"", "Node version");
assertIncludes(workflow, "npm ci", "dependency installation");
assertIncludes(workflow, "npm run typecheck", "typecheck");
assertIncludes(workflow, "npm test", "tests");
assertIncludes(workflow, "npm run build", "build");
assertIncludes(workflow, "npm audit --omit=dev", "runtime dependency audit");

assert.equal(countMatches(workflow, /docker build /g), 1, "release workflow should build the image once");
const buildStep = stepBlock("Build final container image");
assertIncludes(buildStep, 'docker build --file app/Dockerfile --tag "${RELEASE_IMAGE_REF}" app', "release image build");
const smokeStep = stepBlock("Run container smoke test");
assertIncludes(smokeStep, "CONTAINER_SMOKE_IMAGE: ${{ env.RELEASE_IMAGE_REF }}", "smoke image reference");
assertIncludes(smokeStep, 'CONTAINER_SMOKE_SKIP_BUILD: "true"', "smoke image reuse");
const scanStep = stepBlock("Generate container SBOM and vulnerability report");
assertIncludes(scanStep, 'bash scripts/scan-container-image.sh "${RELEASE_IMAGE_REF}"', "scan image reference");
const pushStep = stepBlock("Tag and push image");
assertIncludes(pushStep, 'docker image inspect "${RELEASE_IMAGE_REF}"', "push local image verification");
assertIncludes(pushStep, 'docker tag "${RELEASE_IMAGE_REF}" "${remote_image}"', "push image reference");
assertIncludes(pushStep, 'docker push "${remote_image}"', "image push");

const uploadStep = stepBlock("Upload container security reports");
assertIncludes(uploadStep, "if: ${{ !cancelled() }}", "artifact upload condition");
assertIncludes(uploadStep, "artifacts/container-sbom.cdx.json", "SBOM artifact");
assertIncludes(uploadStep, "artifacts/container-vulnerabilities.json", "vulnerability artifact");
assertIncludes(uploadStep, "if-no-files-found: error", "artifact missing-file behavior");
assertIncludes(uploadStep, "retention-days: 14", "artifact retention");

const validateConfigStep = stepBlock("Validate AWS release configuration");
assertIncludes(validateConfigStep, "AWS_ACCOUNT_ID: ${{ vars.AWS_ACCOUNT_ID }}", "AWS account variable");
assertIncludes(validateConfigStep, "AWS_ECR_RELEASE_ROLE_ARN: ${{ vars.AWS_ECR_RELEASE_ROLE_ARN }}", "release role variable");
assertIncludes(validateConfigStep, "AWS_REGION: ${{ vars.AWS_REGION }}", "AWS region variable");
assertIncludes(validateConfigStep, "ECR_REPOSITORY_NAME: ${{ vars.ECR_REPOSITORY_NAME }}", "ECR repository variable");

const configureAwsStep = stepBlock("Configure AWS credentials");
assertIncludes(configureAwsStep, "role-to-assume: ${{ vars.AWS_ECR_RELEASE_ROLE_ARN }}", "OIDC role ARN");
assertIncludes(configureAwsStep, "role-session-name: ecr-release-${{ github.run_id }}", "role session name");
assertIncludes(configureAwsStep, "role-duration-seconds: 1800", "role duration");
assertIncludes(configureAwsStep, "allowed-account-ids: ${{ vars.AWS_ACCOUNT_ID }}", "allowed account IDs");
assertIncludes(configureAwsStep, "mask-aws-account-id: true", "account ID masking");

const order = [
  "Validate release request",
  "Check out repository",
  "Install app dependencies",
  "Build final container image",
  "Run container smoke test",
  "Generate container SBOM and vulnerability report",
  "Validate AWS release configuration",
  "Configure AWS credentials",
  "Log in to ECR",
  "Fail if immutable tag already exists",
  "Tag and push image",
  "Resolve remote digest"
].map((name) => workflow.indexOf(`- name: ${name}`));
assert(order.every((index) => index >= 0), "all release workflow order markers must exist");
for (let index = 1; index < order.length; index += 1) {
  assert(order[index - 1] < order[index], "release workflow steps are out of order");
}

const duplicateStep = stepBlock("Fail if immutable tag already exists");
assertIncludes(duplicateStep, "aws ecr describe-images", "duplicate tag precheck");
assertIncludes(duplicateStep, "ImageNotFoundException", "duplicate tag not-found handling");
assertIncludes(duplicateStep, "already exists", "duplicate tag fail-closed message");
assertIncludes(duplicateStep, "refusing duplicate release", "duplicate tag fail-closed behavior");

const digestStep = stepBlock("Resolve remote digest");
assertIncludes(digestStep, "aws ecr describe-images", "remote digest lookup");
assertMatches(digestStep, /\^sha256:\[0-9a-f\]\{64\}\$/, "remote digest validation");
assertIncludes(digestStep, "Image published only; ECS was not updated.", "no deployment summary");

for (const forbidden of [
  "continue-on-error",
  "|| true",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "terraform apply",
  "terraform plan",
  "terraform destroy",
  "aws ecs",
  "update-service",
  "register-task-definition",
  "gh release",
  "cosign",
  "provenance",
  "attestation",
  "security-events"
]) {
  assertNotIncludes(workflow, forbidden, "release workflow");
}

assertNotIncludes(releaseIam, "aws_iam_openid_connect_provider", "release IAM");
assertIncludes(releaseIam, "sts:AssumeRoleWithWebIdentity", "OIDC trust action");
assertNotIncludes(releaseIam, "sts:AssumeRole\"", "OIDC trust action");
assertIncludes(releaseIam, "token.actions.githubusercontent.com:aud", "OIDC audience condition");
assertIncludes(releaseIam, "sts.amazonaws.com", "OIDC audience value");
assertIncludes(releaseIam, "token.actions.githubusercontent.com:sub", "OIDC subject condition");
assertIncludes(releaseIam, "repo:${trimspace(var.github_repository)}:environment:${trimspace(var.github_release_environment)}", "OIDC environment subject");
assertNotIncludes(releaseIam, "StringLike", "OIDC trust wildcard");
assertNotIncludes(releaseIam, "repo:*", "OIDC trust wildcard");
assertNotIncludes(releaseIam, "repo:owner/*", "OIDC trust wildcard");
assertNotIncludes(releaseIam, "repo:owner/repo:*", "OIDC trust wildcard");
assertIncludes(releaseIam, "max_session_duration = 3600", "role max session duration uses the AWS minimum");

for (const action of [
  "ecr:BatchCheckLayerAvailability",
  "ecr:BatchGetImage",
  "ecr:CompleteLayerUpload",
  "ecr:DescribeImages",
  "ecr:InitiateLayerUpload",
  "ecr:PutImage",
  "ecr:UploadLayerPart"
]) {
  assertIncludes(releaseIam, action, "release ECR policy");
}
assertIncludes(releaseIam, "resources = [module.ecr.repository_arn]", "single repository scope");
assertMatches(
  releaseIam,
  /actions\s+=\s+\["ecr:GetAuthorizationToken"\]\s+resources\s+=\s+\["\*"\]/,
  "ECR authorization token wildcard"
);
for (const forbidden of ["ecr:*", "ecs:", "iam:", "s3:", "cloudwatch:", "DeleteRepository", "DeleteLifecyclePolicy", "BatchDeleteImage"]) {
  assertNotIncludes(releaseIam, forbidden, "release IAM policy");
}

assertIncludes(variables, 'variable "enable_github_ecr_release_role"', "release role enable variable");
assertIncludes(variables, 'default     = false', "release role default disabled");
assertIncludes(variables, 'variable "github_oidc_provider_arn"', "OIDC provider variable");
assertIncludes(variables, 'variable "github_repository"', "GitHub repository variable");
assertIncludes(variables, 'variable "github_release_environment"', "GitHub environment variable");
assertIncludes(variables, 'default     = "container-release"', "GitHub environment default");
assertIncludes(variables, 'check "github_ecr_release_role"', "release role relationship check");
assertIncludes(main, 'output "github_ecr_release_role_arn"', "release role output");
assertIncludes(main, "try(aws_iam_role.github_ecr_release[0].arn, null)", "disabled release role output safety");

console.log("Release static regression checks passed.");
