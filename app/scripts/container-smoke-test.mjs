#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:net";

const APP_PORT = 3000;
const SHUTDOWN_TIMEOUT_MS = 2000;
const DOCKER_STOP_TIMEOUT_SECONDS = 5;
const READY_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 2_000;
const appDir = new URL("..", import.meta.url);
const imageName = process.env.CONTAINER_SMOKE_IMAGE || `aws-containerized-web-app-smoke:${Date.now()}-${process.pid}`;
const containerName = `aws-containerized-web-app-smoke-${Date.now()}-${process.pid}`;

let containerCreated = false;

class SmokeTestError extends Error {
  constructor(message, { environment = false } = {}) {
    super(message);
    this.environment = environment;
  }
}

function runDocker(args, { cwd = appDir, stream = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      cwd,
      stdio: stream ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    if (!stream) {
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
    }

    child.on("error", (error) => {
      reject(new SmokeTestError(`Unable to run Docker CLI: ${error.message}`, { environment: true }));
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
        return;
      }

      const details = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
      reject(new Error(`docker ${args.join(" ")} failed with exit code ${code}${details ? `\n${details}` : ""}`));
    });
  });
}

async function ensureDockerDaemon() {
  try {
    await runDocker(["version", "--format", "{{.Server.Version}}"]);
  } catch (error) {
    throw new SmokeTestError(
      `Docker daemon is not available. Start Docker and rerun the container smoke test.\n${error.message}`,
      { environment: true }
    );
  }
}

function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") {
          resolve(address.port);
          return;
        }

        reject(new Error("Unable to allocate a local TCP port"));
      });
    });
    server.on("error", reject);
  });
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, { signal: controller.signal });
    const body = await response.json();
    return { body, status: response.status };
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForHealth(baseUrl) {
  const startedAt = Date.now();
  let lastError;

  while (Date.now() - startedAt < READY_TIMEOUT_MS) {
    try {
      const response = await fetchJson(`${baseUrl}/health`);
      if (response.status === 200 && response.body.status === "ok") {
        return;
      }

      lastError = new Error(`Unexpected /health response: ${response.status} ${JSON.stringify(response.body)}`);
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Container did not become healthy within ${READY_TIMEOUT_MS}ms: ${lastError?.message}`);
}

function assertDeepEqual(actual, expected, label) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);

  if (actualJson !== expectedJson) {
    throw new Error(`${label} mismatch. Expected ${expectedJson}; received ${actualJson}`);
  }
}

async function assertContainerHardening(hostPort) {
  const result = await runDocker(["inspect", containerName]);
  const [container] = JSON.parse(result.stdout);
  const hostConfig = container.HostConfig;
  const portBinding = hostConfig.PortBindings?.[`${APP_PORT}/tcp`]?.[0];

  if (hostConfig.ReadonlyRootfs !== true) {
    throw new Error("Container root filesystem is not read-only");
  }

  if (!Array.isArray(hostConfig.CapDrop) || !hostConfig.CapDrop.includes("ALL")) {
    throw new Error("Container does not drop all Linux capabilities");
  }

  if (!Array.isArray(hostConfig.SecurityOpt) || !hostConfig.SecurityOpt.includes("no-new-privileges")) {
    throw new Error("Container does not enable no-new-privileges");
  }

  if (!portBinding || portBinding.HostIp !== "127.0.0.1" || portBinding.HostPort !== String(hostPort)) {
    throw new Error(`Container port is not bound to 127.0.0.1:${hostPort}`);
  }
}

async function assertEndpoint(baseUrl, path, expectedBody) {
  const response = await fetchJson(`${baseUrl}${path}`);

  if (response.status !== 200) {
    throw new Error(`${path} returned HTTP ${response.status}`);
  }

  assertDeepEqual(response.body, expectedBody, path);
}

async function getContainerLogs() {
  if (!containerCreated) {
    return "";
  }

  try {
    const result = await runDocker(["logs", containerName]);
    return [result.stdout, result.stderr].filter(Boolean).join("\n");
  } catch (error) {
    return `Unable to read container logs: ${error.message}`;
  }
}

async function cleanup() {
  if (containerCreated) {
    await runDocker(["rm", "-f", containerName]).catch(() => undefined);
  }
}

async function main() {
  console.log("Checking Docker daemon...");
  await ensureDockerDaemon();

  const hostPort = await getAvailablePort();
  const baseUrl = `http://127.0.0.1:${hostPort}`;

  console.log(`Building image ${imageName}...`);
  await runDocker(["build", "-t", imageName, "."], { stream: true });

  console.log(`Creating container ${containerName} on ${baseUrl}...`);
  await runDocker([
    "create",
    "--name",
    containerName,
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt",
    "no-new-privileges",
    "--env",
    `PORT=${APP_PORT}`,
    "--env",
    `SHUTDOWN_TIMEOUT_MS=${SHUTDOWN_TIMEOUT_MS}`,
    "--publish",
    `127.0.0.1:${hostPort}:${APP_PORT}`,
    imageName
  ]);
  containerCreated = true;
  await assertContainerHardening(hostPort);

  await runDocker(["start", containerName]);

  console.log("Waiting for /health...");
  await waitForHealth(baseUrl);

  console.log("Validating endpoints...");
  await assertEndpoint(baseUrl, "/health", {
    service: "containerized-web-app",
    status: "ok"
  });
  await assertEndpoint(baseUrl, "/", {
    message: "AWS containerized web app sample",
    service: "containerized-web-app"
  });

  console.log("Checking runtime UID...");
  const uid = (await runDocker(["exec", containerName, "node", "-p", "process.getuid()"])).stdout.trim();
  if (uid === "0") {
    throw new Error("Container is running as root");
  }
  if (!/^\d+$/.test(uid)) {
    throw new Error(`Unable to verify numeric runtime UID; received ${JSON.stringify(uid)}`);
  }

  console.log("Stopping container through Docker...");
  const stopStartedAt = Date.now();
  await runDocker(["stop", "--time", String(DOCKER_STOP_TIMEOUT_SECONDS), containerName]);
  const stopElapsedMs = Date.now() - stopStartedAt;
  const stopDeadlineMs = (DOCKER_STOP_TIMEOUT_SECONDS + 2) * 1000;
  if (stopElapsedMs > stopDeadlineMs) {
    throw new Error(`docker stop took ${stopElapsedMs}ms, expected no more than ${stopDeadlineMs}ms`);
  }

  const exitCode = (await runDocker(["inspect", "--format", "{{.State.ExitCode}}", containerName])).stdout.trim();
  if (exitCode !== "0") {
    throw new Error(`Container exited with code ${exitCode}`);
  }

  const logs = await getContainerLogs();
  if (!logs.includes("Received SIGTERM; shutting down HTTP server")) {
    throw new Error("Container logs do not show SIGTERM handling");
  }
  if (!logs.includes("HTTP server shutdown complete")) {
    throw new Error("Container logs do not show normal shutdown completion");
  }

  console.log(`Container smoke test passed. Runtime UID: ${uid}; docker stop completed in ${stopElapsedMs}ms.`);
}

try {
  await main();
} catch (error) {
  console.error(error.environment ? "Environment error:" : "Container smoke test failed:");
  console.error(error.message);

  const logs = await getContainerLogs();
  if (logs) {
    console.error("\nContainer logs:");
    console.error(logs);
  }

  process.exitCode = 1;
} finally {
  await cleanup();
}
