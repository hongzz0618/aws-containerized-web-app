#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <image-reference>" >&2
  exit 2
fi

image_ref="$1"
artifact_dir="${CONTAINER_SCAN_ARTIFACT_DIR:-artifacts}"
sbom_path="${artifact_dir}/container-sbom.cdx.json"
vuln_path="${artifact_dir}/container-vulnerabilities.json"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker CLI is required to verify the local image." >&2
  exit 1
fi

if ! command -v trivy >/dev/null 2>&1; then
  echo "Trivy CLI is required to generate the SBOM and vulnerability report." >&2
  exit 1
fi

if ! docker image inspect "$image_ref" >/dev/null 2>&1; then
  echo "Container image ${image_ref} does not exist in the local Docker daemon." >&2
  exit 1
fi

mkdir -p "$artifact_dir"
rm -f "$sbom_path" "$vuln_path"

echo "Trivy version:"
trivy --version

echo "Generating CycloneDX SBOM for ${image_ref}..."
trivy image \
  --format cyclonedx \
  --output "$sbom_path" \
  "$image_ref"

echo "Generating full vulnerability report for ${image_ref}..."
trivy image \
  --scanners vuln \
  --vuln-type os,library \
  --severity UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL \
  --format json \
  --exit-code 0 \
  --output "$vuln_path" \
  "$image_ref"

echo "Vulnerability summary for ${image_ref}:"
trivy image \
  --scanners vuln \
  --vuln-type os,library \
  --severity UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL \
  --format table \
  --exit-code 0 \
  "$image_ref"

node - "$sbom_path" "$vuln_path" "$image_ref" <<'NODE'
const [sbomPath, vulnPath, imageRef] = process.argv.slice(2);
const { readFileSync, statSync } = await import("node:fs");

function readJson(path) {
  if (statSync(path).size === 0) {
    throw new Error(`${path} is empty`);
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

const sbom = readJson(sbomPath);
if (sbom.bomFormat !== "CycloneDX") {
  throw new Error(`${sbomPath} is not a CycloneDX SBOM`);
}
if (!sbom.metadata?.component && !Array.isArray(sbom.components)) {
  throw new Error(`${sbomPath} does not include component metadata`);
}
if (Array.isArray(sbom.components) && sbom.components.length === 0) {
  throw new Error(`${sbomPath} contains an empty components array`);
}

const targetText = JSON.stringify(sbom.metadata?.component ?? {});
if (!targetText.includes(imageRef) && !targetText.includes(imageRef.split(":")[0])) {
  throw new Error(`${sbomPath} does not appear to describe ${imageRef}`);
}

const report = readJson(vulnPath);
if (!Array.isArray(report.Results)) {
  throw new Error(`${vulnPath} does not include Trivy Results`);
}

console.log(`Validated SBOM and vulnerability report for ${imageRef}.`);
NODE

echo "Applying vulnerability gate: fail on fixable CRITICAL vulnerabilities only."
trivy image \
  --scanners vuln \
  --vuln-type os,library \
  --ignore-unfixed \
  --severity CRITICAL \
  --exit-code 1 \
  "$image_ref"
