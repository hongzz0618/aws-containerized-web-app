import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

import {
  DEFAULT_PORT,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  createAppServer,
  createShutdownHandler,
  getRuntimeConfig
} from "../src/server.js";

async function request(path: string): Promise<{ status: number; body: unknown }> {
  const server = createAppServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  assert(address && typeof address === "object");

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`);
    return {
      status: response.status,
      body: await response.json()
    };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }
}

describe("sample container app", () => {
  it("returns health status", async () => {
    const response = await request("/health");

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      status: "ok",
      service: "containerized-web-app"
    });
  });

  it("returns a root response", async () => {
    const response = await request("/");

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      message: "AWS containerized web app sample",
      service: "containerized-web-app"
    });
  });

  it("returns not found for unknown routes", async () => {
    const response = await request("/missing");

    assert.equal(response.status, 404);
    assert.deepEqual(response.body, { error: "not_found" });
  });
});

describe("runtime configuration", () => {
  it("uses documented defaults when environment variables are absent", () => {
    assert.deepEqual(getRuntimeConfig({}), {
      port: DEFAULT_PORT,
      shutdownTimeoutMs: DEFAULT_SHUTDOWN_TIMEOUT_MS
    });
  });

  it("accepts valid numeric environment variables", () => {
    assert.deepEqual(
      getRuntimeConfig({
        PORT: "3100",
        SHUTDOWN_TIMEOUT_MS: "250"
      }),
      {
        port: 3100,
        shutdownTimeoutMs: 250
      }
    );
  });

  it("rejects invalid shutdown timeout configuration", () => {
    assert.throws(
      () =>
        getRuntimeConfig({
          PORT: "3000",
          SHUTDOWN_TIMEOUT_MS: "0"
        }),
      /SHUTDOWN_TIMEOUT_MS must be an integer/
    );
  });
});

describe("graceful shutdown", () => {
  it("initiates shutdown and lets an idle server close cleanly", async () => {
    const server = createAppServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const exitCodes: number[] = [];
    const logs: string[] = [];
    const shutdown = createShutdownHandler({
      exit: (code) => {
        exitCodes.push(code);
      },
      logger: {
        error: (...args: unknown[]) => logs.push(args.join(" ")),
        log: (...args: unknown[]) => logs.push(args.join(" "))
      },
      server,
      timeoutMs: 1_000
    });

    shutdown("SIGTERM");

    await assert.doesNotReject(
      new Promise<void>((resolve, reject) => {
        const startedAt = Date.now();
        const timer = setInterval(() => {
          if (exitCodes.length > 0) {
            clearInterval(timer);
            resolve();
          } else if (Date.now() - startedAt > 1_000) {
            clearInterval(timer);
            reject(new Error("shutdown did not complete"));
          }
        }, 10);
      })
    );

    assert.deepEqual(exitCodes, [0]);
    assert(logs.some((line) => line.includes("Received SIGTERM; shutting down HTTP server")));
    assert(logs.some((line) => line.includes("HTTP server shutdown complete")));
  });

  it("ignores duplicate shutdown requests", () => {
    let closeCalls = 0;
    let idleCloseCalls = 0;
    const exitCodes: number[] = [];
    const logs: string[] = [];

    const shutdown = createShutdownHandler({
      clearTimeoutFn: () => undefined,
      exit: (code) => {
        exitCodes.push(code);
      },
      logger: {
        error: (...args: unknown[]) => logs.push(args.join(" ")),
        log: (...args: unknown[]) => logs.push(args.join(" "))
      },
      server: {
        close: (callback?: (error?: Error) => void) => {
          closeCalls += 1;
          callback?.();
        },
        closeIdleConnections: () => {
          idleCloseCalls += 1;
        }
      },
      setTimeoutFn: (() => 1 as unknown as ReturnType<typeof setTimeout>),
      timeoutMs: 1_000
    });

    shutdown("SIGTERM");
    shutdown("SIGINT");

    assert.equal(closeCalls, 1);
    assert.equal(idleCloseCalls, 1);
    assert.deepEqual(exitCodes, [0]);
    assert(logs.some((line) => line.includes("Received SIGINT; shutdown already in progress")));
  });

  it("force-closes remaining connections after the shutdown deadline", () => {
    let closeCallback: ((error?: Error) => void) | undefined;
    let closeAllCalls = 0;
    let idleCloseCalls = 0;
    let timeoutCallback: (() => void) | undefined;
    const exitCodes: number[] = [];
    const logs: string[] = [];

    const shutdown = createShutdownHandler({
      clearTimeoutFn: () => undefined,
      exit: (code) => {
        exitCodes.push(code);
      },
      logger: {
        error: (...args: unknown[]) => logs.push(args.join(" ")),
        log: (...args: unknown[]) => logs.push(args.join(" "))
      },
      server: {
        close: (callback?: (error?: Error) => void) => {
          closeCallback = callback;
        },
        closeAllConnections: () => {
          closeAllCalls += 1;
        },
        closeIdleConnections: () => {
          idleCloseCalls += 1;
        }
      },
      setTimeoutFn: ((callback: () => void) => {
        timeoutCallback = callback;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      }),
      timeoutMs: 100
    });

    shutdown("SIGTERM");

    assert.equal(idleCloseCalls, 1);
    assert.equal(closeAllCalls, 0);
    assert.deepEqual(exitCodes, []);

    assert(timeoutCallback);
    timeoutCallback();

    assert.equal(closeAllCalls, 1);
    assert.deepEqual(exitCodes, []);

    assert(closeCallback);
    closeCallback();

    assert.deepEqual(exitCodes, [1]);
    assert(logs.some((line) => line.includes("forcing remaining connections closed")));
    assert(logs.some((line) => line.includes("completed after forced connection close")));
  });
});
