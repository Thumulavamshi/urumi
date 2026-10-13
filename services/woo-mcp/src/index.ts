// WooCommerce MCP server over Streamable HTTP.
//
//   POST /mcp     MCP endpoint (bearer token required; only the gateway has it)
//   GET  /healthz liveness: the process is serving
//   GET  /readyz  readiness: config loaded and listening. Deliberately does NOT
//                 depend on the store: if WordPress is down we stay reachable
//                 and tools return a clear "store unreachable" error, instead of
//                 the whole server disappearing from the Service.
//   GET  /status  diagnostics incl. store reachability (not used by probes)
//
// Stateless: a fresh McpServer + transport per HTTP request, no session state,
// so any replica can serve any request.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual, createHash } from "node:crypto";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { McpServer } from "@modelcontextprotocol/server";
import { loadConfig } from "./config.ts";
import { WooClient } from "./woo.ts";
import { registerTools } from "./tools.ts";

const VERSION = "0.1.0";
const cfg = loadConfig();
const woo = new WooClient(cfg);

// Compare SHA-256 digests so timingSafeEqual gets equal-length inputs and the
// comparison time doesn't leak how much of the token matched.
const expectedTokenDigest = createHash("sha256").update(cfg.authToken).digest();
function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  const digest = createHash("sha256").update(match[1]!.trim()).digest();
  return timingSafeEqual(digest, expectedTokenDigest);
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function log(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...event }));
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authorized(req)) {
    log({ msg: "mcp unauthorized", remote: req.socket.remoteAddress });
    json(res, 401, { error: "unauthorized" }, { "www-authenticate": 'Bearer realm="woo-mcp"' });
    return;
  }

  const server = new McpServer({ name: "woocommerce", version: VERSION });
  registerTools(server, woo);
  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res);
}

const http = createServer(async (req, res) => {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  try {
    if (path === "/healthz" || path === "/readyz") return json(res, 200, { ok: true });
    if (path === "/status") {
      return json(res, 200, { version: VERSION, store: cfg.storePublicUrl, storeReachable: await woo.ping() });
    }
    if (path === "/mcp") return await handleMcp(req, res);
    json(res, 404, { error: "not found" });
  } catch (err) {
    log({ msg: "request failed", path, error: (err as Error).message });
    if (!res.headersSent) json(res, 500, { error: "internal error" });
  }
});

http.listen(cfg.port, () => log({ msg: "woo-mcp listening", port: cfg.port, store: cfg.storePublicUrl }));

// Kubernetes sends SIGTERM before killing the pod: stop accepting, finish in-flight.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    log({ msg: `received ${signal}, shutting down` });
    http.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
