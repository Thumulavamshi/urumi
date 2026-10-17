// Shared HTTP shell for the small MCP servers in this package (same shape as
// woo-mcp):
//
//   POST /mcp     MCP endpoint (Streamable HTTP, stateless: a fresh McpServer +
//                 transport per request, so any replica can serve any request)
//   GET  /healthz liveness
//   GET  /readyz  readiness
//
// Each server only decides *how* a caller authenticates and which tools exist.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { McpServer } from "@modelcontextprotocol/server";

export const VERSION = "0.1.0";

export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var ${name}`);
  return value;
}

export function log(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...event }));
}

/**
 * Constant-time secret comparison. Comparing SHA-256 digests gives
 * timingSafeEqual equal-length inputs and doesn't leak how much matched.
 */
export function secretMatches(presented: string | undefined, expected: string): boolean {
  if (!presented) return false;
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export function bearerToken(req: IncomingMessage): string | undefined {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
  return match?.[1]?.trim();
}

export function ok(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

export function fail(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

export interface ServeOptions {
  /** MCP server name reported in initialize. */
  name: string;
  port: number;
  /** true if the request carries the right credential. */
  authorize: (req: IncomingMessage) => boolean;
  /** Value of WWW-Authenticate on 401s. */
  challenge: string;
  register: (server: McpServer) => void;
  /** Readiness beyond "process is up" (e.g. data dir writable). */
  ready?: () => boolean;
  onShutdown?: () => Promise<void> | void;
}

export function serve(opts: ServeOptions): void {
  async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!opts.authorize(req)) {
      log({ msg: "mcp unauthorized", remote: req.socket.remoteAddress });
      json(res, 401, { error: "unauthorized" }, { "www-authenticate": opts.challenge });
      return;
    }
    const server = new McpServer({ name: opts.name, version: VERSION });
    opts.register(server);
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
      if (path === "/healthz") return json(res, 200, { ok: true });
      if (path === "/readyz") {
        const ready = opts.ready ? opts.ready() : true;
        return json(res, ready ? 200 : 503, { ok: ready });
      }
      if (path === "/mcp") return await handleMcp(req, res);
      json(res, 404, { error: "not found" });
    } catch (err) {
      log({ msg: "request failed", path, error: (err as Error).message });
      if (!res.headersSent) json(res, 500, { error: "internal error" });
    }
  });

  http.listen(opts.port, () => log({ msg: `${opts.name} listening`, port: opts.port }));

  // Kubernetes sends SIGTERM before killing the pod: stop accepting, finish in-flight.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      log({ msg: `received ${signal}, shutting down` });
      http.close(async () => {
        await opts.onShutdown?.();
        process.exit(0);
      });
      setTimeout(() => process.exit(0), 10_000).unref();
    });
  }
}
