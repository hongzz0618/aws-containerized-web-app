import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";

export const DEFAULT_PORT = 3000;
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
export const MIN_SHUTDOWN_TIMEOUT_MS = 100;
export const MAX_SHUTDOWN_TIMEOUT_MS = 120_000;

type JsonBody = Record<string, string>;

type Logger = Pick<Console, "error" | "log">;
type Exit = (code: number) => void;
type Timer = ReturnType<typeof setTimeout>;
type SetTimeoutFn = (callback: () => void, delayMs: number) => Timer;
type ClearTimeoutFn = (timer: Timer) => void;

interface IntegerConfigOptions {
  defaultValue: number;
  max: number;
  min: number;
  name: string;
  value: string | undefined;
}

interface ShutdownServer {
  close(callback?: (error?: Error) => void): unknown;
  closeAllConnections?: () => void;
  closeIdleConnections?: () => void;
}

interface ShutdownOptions {
  clearTimeoutFn?: ClearTimeoutFn;
  exit?: Exit;
  logger?: Logger;
  server: ShutdownServer;
  setTimeoutFn?: SetTimeoutFn;
  timeoutMs: number;
}

interface RuntimeConfig {
  port: number;
  shutdownTimeoutMs: number;
}

function readIntegerConfig({ defaultValue, max, min, name, value }: IntegerConfigOptions): number {
  if (value === undefined) {
    return defaultValue;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}; received ${JSON.stringify(value)}`);
  }

  return parsed;
}

export function getRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  return {
    port: readIntegerConfig({
      defaultValue: DEFAULT_PORT,
      max: 65_535,
      min: 1,
      name: "PORT",
      value: env.PORT
    }),
    shutdownTimeoutMs: readIntegerConfig({
      defaultValue: DEFAULT_SHUTDOWN_TIMEOUT_MS,
      max: MAX_SHUTDOWN_TIMEOUT_MS,
      min: MIN_SHUTDOWN_TIMEOUT_MS,
      name: "SHUTDOWN_TIMEOUT_MS",
      value: env.SHUTDOWN_TIMEOUT_MS
    })
  };
}

function sendJson(response: ServerResponse, statusCode: number, body: JsonBody): void {
  const payload = JSON.stringify(body);

  response.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload)
  });
  response.end(payload);
}

export function handleRequest(request: IncomingMessage, response: ServerResponse): void {
  const url = new URL(request.url || "/", "http://localhost");

  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, { status: "ok", service: "containerized-web-app" });
    return;
  }

  if (request.method === "GET" && url.pathname === "/") {
    sendJson(response, 200, {
      message: "AWS containerized web app sample",
      service: "containerized-web-app"
    });
    return;
  }

  sendJson(response, 404, { error: "not_found" });
}

export function createAppServer(): Server {
  return createServer(handleRequest);
}

export function createShutdownHandler({
  clearTimeoutFn = clearTimeout,
  exit = (code) => {
    process.exit(code);
  },
  logger = console,
  server,
  setTimeoutFn = setTimeout,
  timeoutMs
}: ShutdownOptions): (signal: NodeJS.Signals) => void {
  let forceCloseTimer: Timer | undefined;
  let forcedClose = false;
  let shutdownStarted = false;

  return (signal: NodeJS.Signals): void => {
    if (shutdownStarted) {
      logger.log(`Received ${signal}; shutdown already in progress`);
      return;
    }

    shutdownStarted = true;
    logger.log(`Received ${signal}; shutting down HTTP server`);

    forceCloseTimer = setTimeoutFn(() => {
      forcedClose = true;
      logger.error(`HTTP server shutdown exceeded ${timeoutMs}ms; forcing remaining connections closed`);
      server.closeAllConnections?.();
    }, timeoutMs);

    server.close((error) => {
      if (forceCloseTimer) {
        clearTimeoutFn(forceCloseTimer);
        forceCloseTimer = undefined;
      }

      if (error) {
        logger.error("HTTP server shutdown failed", error);
        exit(1);
        return;
      }

      if (forcedClose) {
        logger.error("HTTP server shutdown completed after forced connection close");
        exit(1);
        return;
      }

      logger.log("HTTP server shutdown complete");
      exit(0);
    });

    server.closeIdleConnections?.();
  };
}

function start(): void {
  const { port, shutdownTimeoutMs } = getRuntimeConfig();
  const server = createAppServer();
  const shutdown = createShutdownHandler({ server, timeoutMs: shutdownTimeoutMs });

  server.listen(port, () => {
    console.log(`Container app listening on port ${port}`);
  });

  server.on("error", (error) => {
    console.error("HTTP server failed", error);
    process.exit(1);
  });

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (isMain) {
  try {
    start();
  } catch (error) {
    console.error("Container app failed to start", error);
    process.exit(1);
  }
}
