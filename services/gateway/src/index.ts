// MCP gateway.
//
//   /mcp        aggregated MCP endpoint (API key)            -> mcp.ts
//   /api/...    dashboard + admin REST API (session cookie)  -> api/*
//   /healthz    liveness: the process is serving
//   /readyz     readiness: Postgres reachable. NOT upstream health — one dead
//               upstream must never take the gateway out of the Service.
import express, { type NextFunction, type Request, type Response } from "express";
import { authRoutes } from "./api/auth.ts";
import { auditRoutes } from "./api/audit.ts";
import { keyRoutes } from "./api/keys.ts";
import { serverRoutes } from "./api/servers.ts";
import { userRoutes } from "./api/users.ts";
import type { Deps } from "./api/util.ts";
import { HttpError, requireUser } from "./auth.ts";
import { bootstrap } from "./bootstrap.ts";
import { loadConfig } from "./config.ts";
import { CredentialBox } from "./crypto.ts";
import { createPool, migrate, waitForDb } from "./db.ts";
import { errorMessage, log } from "./log.ts";
import { McpEndpoint } from "./mcp.ts";
import { ToolRouter } from "./router.ts";
import { UpstreamManager, VERSION } from "./upstreams.ts";

const cfg = loadConfig();
const db = createPool(cfg.databaseUrl);
const box = new CredentialBox(cfg.encryptionKey);

await waitForDb(db);
await migrate(db);
await bootstrap(db, cfg, box);

const upstreams = new UpstreamManager(db, box, { intervalMs: cfg.healthIntervalMs, timeoutMs: cfg.healthTimeoutMs });
const router = new ToolRouter(db, upstreams, { callTimeoutMs: cfg.callTimeoutMs });
const mcp = new McpEndpoint(db, upstreams, router);
await upstreams.start();

const deps: Deps = { db, cfg, box, upstreams, mcp };
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1); // behind the ingress controller
app.use(express.json({ limit: "1mb" }));

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});
app.get("/readyz", async (_req, res) => {
  try {
    await db.query("SELECT 1");
    res.json({ ok: true });
  } catch (err) {
    res.status(503).json({ ok: false, error: errorMessage(err) });
  }
});

app.all("/mcp", (req, res) => mcp.handle(req, res));

const api = express.Router();
api.use(authRoutes(deps)); // login/invite routes are public; /auth/me checks itself
api.use(requireUser(db));
api.use(keyRoutes(deps));
api.use(serverRoutes(deps));
api.use(userRoutes(deps));
api.use(auditRoutes(deps));
app.use("/api", api);

app.use((_req, res) => {
  res.status(404).json({ error: "not found" });
});
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  // express.json() parse errors carry a status; everything else is ours.
  const status = (err as { status?: number }).status;
  if (status && status < 500) {
    res.status(status).json({ error: errorMessage(err) });
    return;
  }
  log({ msg: "request failed", method: req.method, path: req.path, error: errorMessage(err) });
  if (!res.headersSent) res.status(500).json({ error: "internal error" });
});

const server = app.listen(cfg.port, () => log({ msg: "gateway listening", port: cfg.port, version: VERSION }));

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    log({ msg: `received ${signal}, shutting down` });
    server.close();
    void Promise.allSettled([mcp.close(), upstreams.stop()]).then(() => db.end()).then(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
