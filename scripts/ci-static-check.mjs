#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
const smokeTest = readFileSync("app/scripts/container-smoke-test.mjs", "utf8");
const scanScript = readFileSync("scripts/scan-container-image.sh", "utf8");
const gitignore = readFileSync(".gitignore", "utf8");

function stepBlock(name) {
  const pattern = new RegExp(`\\n\\s+- name: ${name}\\n([\\s\\S]*?)(?=\\n\\s+- name: |\\n\\s{2}[a-zA-Z0-9_-]+:|\\n?$)`);
  const match = workflow.match(pattern);
  assert(match, `workflow step missing: ${name}`);
  return match[0];
}

function assertIncludes(content, expected, label) {
  assert(content.includes(expected), `${label} is missing ${JSON.stringify(expected)}`);
}

function assertNotIncludes(content, unexpected, label) {
  assert(!content.includes(unexpected), `${label} must not include ${JSON.stringify(unexpected)}`);
}

assertIncludes(workflow, "permissions:\n  contents: read", "workflow permissions");
assertNotIncludes(workflow, "id-token: write", "workflow permissions");
assertNotIncludes(workflow, "packages: write", "workflow permissions");
assertNotIncludes(workflow, "pull-requests: write", "workflow permissions");
assertNotIncludes(workflow, "write-all", "workflow permissions");
assertNotIncludes(workflow, "aws-actions/configure-aws-credentials", "workflow");
assertNotIncludes(workflow, "docker push", "workflow");
assertNotIncludes(workflow, "ecr", "workflow");
assertNotIncludes(workflow, "continue-on-error", "workflow");

assertIncludes(workflow, "CI_IMAGE_REF: aws-containerized-web-app:ci-${{ github.sha }}", "CI image reference");

const buildStep = stepBlock("Build final container image");
assertIncludes(buildStep, 'docker build --file app/Dockerfile --tag "${CI_IMAGE_REF}" app', "container build step");

const smokeStep = stepBlock("Run container smoke test");
assertIncludes(smokeStep, "CONTAINER_SMOKE_IMAGE: ${{ env.CI_IMAGE_REF }}", "smoke image reference");
assertIncludes(smokeStep, 'CONTAINER_SMOKE_SKIP_BUILD: "true"', "smoke image reuse");

const scanStep = stepBlock("Generate container SBOM and vulnerability report");
assertIncludes(scanStep, 'bash scripts/scan-container-image.sh "${CI_IMAGE_REF}"', "scan image reference");

const trivyStep = stepBlock("Set up Trivy");
assertIncludes(trivyStep, "uses: aquasecurity/setup-trivy@v0.3.1", "Trivy setup action");
assertIncludes(trivyStep, "version: v0.71.2", "Trivy CLI version");
assertIncludes(trivyStep, "cache: true", "Trivy binary cache");

const uploadStep = stepBlock("Upload container security reports");
assertIncludes(uploadStep, "if: always()", "artifact upload condition");
assertIncludes(uploadStep, "artifacts/container-sbom.cdx.json", "SBOM artifact path");
assertIncludes(uploadStep, "artifacts/container-vulnerabilities.json", "vulnerability artifact path");
assertIncludes(uploadStep, "retention-days: 14", "artifact retention");

assertIncludes(smokeTest, "CONTAINER_SMOKE_SKIP_BUILD", "smoke script image reuse support");
assertIncludes(smokeTest, 'runDocker(["image", "inspect", imageName])', "smoke script local image verification");

assertIncludes(scanScript, "trivy image", "scan script image target");
assertIncludes(scanScript, "--format cyclonedx", "SBOM format");
assertIncludes(scanScript, "container-sbom.cdx.json", "SBOM output");
assertIncludes(scanScript, "container-vulnerabilities.json", "vulnerability report output");
assertIncludes(scanScript, "--severity UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL", "full report severities");
assertIncludes(scanScript, "--ignore-unfixed", "fixable vulnerability gate");
assertIncludes(scanScript, "--severity CRITICAL", "critical gate severity");
assertIncludes(scanScript, "--exit-code 1", "failing vulnerability gate");
assertNotIncludes(scanScript, "docker push", "scan script");
assertNotIncludes(scanScript, "aws ", "scan script");

assertIncludes(gitignore, "artifacts/", "generated artifact ignore");
assertIncludes(gitignore, ".cache/trivy/", "Trivy cache ignore");

console.log("CI static regression checks passed.");
