import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";

const port = Number(process.env.PORT || 3000);

type JsonBody = Record<string, string>;

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

const server = createServer(handleRequest);

function shutdown(signal: NodeJS.Signals): void {
  console.log(`Received ${signal}; shutting down HTTP server`);
  server.close((error) => {
    if (error) {
      console.error("HTTP server shutdown failed", error);
      process.exit(1);
    }

    process.exit(0);
  });
}

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (isMain) {
  server.listen(port, () => {
    console.log(`Container app listening on port ${port}`);
  });

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
