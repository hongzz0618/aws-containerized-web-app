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

function assertMatches(content, pattern, label) {
  assert(pattern.test(content), `${label} does not match ${pattern}`);
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
assertMatches(
  trivyStep,
  /uses:\s+aquasecurity\/setup-trivy@[0-9a-f]{40}\s+# v0\.3\.1/,
  "Trivy setup action immutable pin"
);
assertIncludes(
  trivyStep,
  "uses: aquasecurity/setup-trivy@81e514348e19b6112ce2a7e3ecbafe19c1e1f567 # v0.3.1",
  "Trivy setup action release SHA"
);
assertNotIncludes(trivyStep, "aquasecurity/setup-trivy@v0.3.1\n", "Trivy setup action floating tag");
assertIncludes(trivyStep, "version: v0.71.2", "Trivy CLI version");
assertNotIncludes(trivyStep, "version: latest", "Trivy CLI version");
assertIncludes(trivyStep, "cache: true", "Trivy binary cache");

const uploadStep = stepBlock("Upload container security reports");
assertIncludes(uploadStep, "if: ${{ !cancelled() }}", "artifact upload condition");
assertIncludes(uploadStep, "artifacts/container-sbom.cdx.json", "SBOM artifact path");
assertIncludes(uploadStep, "artifacts/container-vulnerabilities.json", "vulnerability artifact path");
assertIncludes(uploadStep, "if-no-files-found: error", "artifact missing-file behavior");
assertIncludes(uploadStep, "retention-days: 14", "artifact retention");

assertIncludes(smokeTest, "CONTAINER_SMOKE_SKIP_BUILD", "smoke script image reuse support");
assertIncludes(smokeTest, 'runDocker(["image", "inspect", imageName])', "smoke script local image verification");

assertIncludes(scanScript, "trivy image", "scan script image target");
assertIncludes(scanScript, "--format cyclonedx", "SBOM format");
assertIncludes(scanScript, "container-sbom.cdx.json", "SBOM output");
assertIncludes(scanScript, "container-vulnerabilities.json", "vulnerability report output");
assertIncludes(scanScript, "--severity UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL", "full report severities");
assertIncludes(scanScript, 'rm -f "$sbom_path" "$vuln_path"', "report cleanup");
assertMatches(
  scanScript,
  /--severity UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL\s*\\\n\s*--format json\s*\\\n\s*--exit-code 0\s*\\\n\s*--output "\$vuln_path"\s*\\\n\s*"\$image_ref"/,
  "full vulnerability report command"
);
assertIncludes(scanScript, "--ignore-unfixed", "fixable vulnerability gate");
assertMatches(
  scanScript,
  /--ignore-unfixed\s*\\\n\s*--severity CRITICAL\s*\\\n\s*--exit-code 1\s*\\\n\s*"\$image_ref"/,
  "fixable critical vulnerability gate"
);
assertNotIncludes(scanScript, "|| true", "scan script");
assertNotIncludes(scanScript, "docker push", "scan script");
assertNotIncludes(scanScript, "aws ", "scan script");

assertIncludes(gitignore, "artifacts/", "generated artifact ignore");
assertIncludes(gitignore, ".cache/trivy/", "Trivy cache ignore");

console.log("CI static regression checks passed.");
