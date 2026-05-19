import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";

import { handleRequest } from "../src/server.js";

async function request(path: string): Promise<{ status: number; body: unknown }> {
  const server = createServer(handleRequest);
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
