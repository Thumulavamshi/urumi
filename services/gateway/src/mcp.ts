// The gateway's own MCP endpoint (Streamable HTTP at /mcp): what Claude Code,
// Cursor, Inspector and the built-in chat agent connect to.
//
// Every HTTP request is authenticated with the caller's personal API key
// (looked up in Postgres each time => revocation is effective on the next
// request). The key decides WHO the request acts as; upstream credentials are
// added later by the upstream manager and never leave the gateway.
//
// Sessions: clients that do the classic `initialize` handshake get a stateful
// session (Mcp-Session-Id) bound to their API key. That gives them a GET/SSE
// stream on which we push `notifications/tools/list_changed` when servers are
// enabled/disabled/go down, so their tool list refreshes without a reconnect.
// Requests without a session id that aren't `initialize` (e.g. 2026-07-28-era
// clients, curl) are served statelessly by a throwaway server instance.
// Sessions live in this replica's memory; see docs/design.md for scaling.
import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { isInitializeRequest, Server } from "@modelcontextprotocol/server";
import { bearerToken, principalFromApiKey, type Principal } from "./auth.ts";
import type { Db } from "./db.ts";
import { errorMessage, log } from "./log.ts";
import type { ToolRouter } from "./router.ts";
import { VERSION, type UpstreamManager } from "./upstreams.ts";

const SESSION_IDLE_MS = 30 * 60_000;

const INSTRUCTIONS =
  "This is a team MCP gateway. Tools are named <server>__<tool>; the prefix tells you which upstream " +
  "server handles the call (e.g. woo__list_orders runs on the WooCommerce store). Descriptions start " +
  "with the server name in brackets.";

interface Session {
  id: string;
  principal: Principal;
  server: Server;
  transport: NodeStreamableHTTPServerTransport;
  lastSeen: number;
}

export class McpEndpoint {
  #db: Db;
  #upstreams: UpstreamManager;
  #router: ToolRouter;
  #sessions = new Map<string, Session>();
  #sweeper: NodeJS.Timeout;

  constructor(db: Db, upstreams: UpstreamManager, router: ToolRouter) {
    this.#db = db;
    this.#upstreams = upstreams;
    this.#router = router;
    upstreams.on("toolsChanged", () => this.#broadcastToolsChanged());
    this.#sweeper = setInterval(() => this.#sweep(), 60_000);
    this.#sweeper.unref();
  }

  /** Build an MCP server instance whose handlers act as `getPrincipal()`. */
  #buildServer(getPrincipal: () => Principal): Server {
    const server = new Server(
      { name: "urumi-mcp-gateway", version: VERSION },
      { capabilities: { tools: { listChanged: true } }, instructions: INSTRUCTIONS },
    );
    // Each user sees only the tools their role may call (src/policy.ts).
    server.setRequestHandler("tools/list", async () => ({
      tools: this.#router.policy.filter(getPrincipal(), this.#upstreams.aggregatedTools()),
    }));
    server.setRequestHandler("tools/call", async (request, ctx) =>
      this.#router.call(getPrincipal(), request.params.name, request.params.arguments, "mcp", ctx.mcpReq.signal),
    );
    server.onerror = (err) => log({ msg: "mcp server error", error: errorMessage(err) });
    return server;
  }

  async handle(req: Request, res: Response): Promise<void> {
    const key = bearerToken(req);
    const principal = key ? await principalFromApiKey(this.#db, key) : undefined;
    if (!principal) {
      res
        .status(401)
        .set("www-authenticate", 'Bearer realm="mcp-gateway"')
        .json({ jsonrpc: "2.0", error: { code: -32001, message: "Invalid, revoked or missing API key" }, id: null });
      return;
    }

    const sessionId = req.header("mcp-session-id");
    if (sessionId) {
      const session = this.#sessions.get(sessionId);
      // A session belongs to the key that created it: another key can't ride on it.
      if (!session || session.principal.apiKeyId !== principal.apiKeyId) {
        res.status(404).json({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null });
        return;
      }
      session.principal = principal; // pick up role/name changes
      session.lastSeen = Date.now();
      await session.transport.handleRequest(req, res, req.body);
      return;
    }

    if (req.method === "POST" && isInitializeRequest(req.body)) {
      const session = { principal, lastSeen: Date.now() } as Session;
      session.server = this.#buildServer(() => session.principal);
      session.transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          session.id = id;
          this.#sessions.set(id, session);
          log({ msg: "mcp session opened", user: principal.email, session: id });
        },
        onsessionclosed: (id) => this.#drop(id),
      });
      session.transport.onclose = () => session.id && this.#drop(session.id);
      await session.server.connect(session.transport);
      await session.transport.handleRequest(req, res, req.body);
      return;
    }

    if (req.method === "POST") {
      // Stateless: fresh server + transport for this one request.
      const server = this.#buildServer(() => principal);
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Mcp-Session-Id header required" }, id: null });
  }

  /** Revocation / user disable: cut live sessions immediately (their next request would fail anyway). */
  closeSessions(match: (p: Principal) => boolean): number {
    let closed = 0;
    for (const s of [...this.#sessions.values()]) {
      if (match(s.principal)) {
        void s.transport.close();
        this.#drop(s.id);
        closed++;
      }
    }
    return closed;
  }

  get sessionCount(): number {
    return this.#sessions.size;
  }

  #drop(id: string): void {
    const s = this.#sessions.get(id);
    if (!s) return;
    this.#sessions.delete(id);
    void s.server.close().catch(() => {});
    log({ msg: "mcp session closed", user: s.principal.email, session: id });
  }

  #broadcastToolsChanged(): void {
    log({ msg: "tool list changed, notifying sessions", sessions: this.#sessions.size });
    for (const s of this.#sessions.values()) {
      s.server.sendToolListChanged().catch(() => {}); // no open GET stream => nothing to deliver
    }
  }

  #sweep(): void {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const s of [...this.#sessions.values()]) {
      if (s.lastSeen < cutoff) {
        void s.transport.close();
        this.#drop(s.id);
      }
    }
  }

  async close(): Promise<void> {
    clearInterval(this.#sweeper);
    await Promise.allSettled([...this.#sessions.values()].map((s) => s.transport.close()));
  }
}
