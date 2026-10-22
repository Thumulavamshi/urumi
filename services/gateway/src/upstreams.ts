// Upstream manager: one long-lived MCP client per enabled upstream server.
//
// - The `servers` table is the source of truth. Every tick we re-read it, so an
//   edit made through any gateway replica reaches every replica within one tick.
// - Health: each tick, `tools/list` on every enabled server (with a timeout).
//   Success => "connected" and a fresh tool cache. Failure => "unreachable" with
//   the reason, client dropped, retried with backoff. Checks run in parallel and
//   are independent, so one dead/slow upstream never delays the others.
// - Emits "toolsChanged" whenever the set of tools the gateway exposes changes
//   (server added/removed/enabled/disabled/went down/came back, tools changed),
//   which the MCP endpoint turns into `notifications/tools/list_changed`.
import { EventEmitter } from "node:events";
import {
  Client,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  StreamableHTTPClientTransport,
  type Tool,
} from "@modelcontextprotocol/client";
import type { Db } from "./db.ts";
import type { CredentialBox } from "./crypto.ts";
import { errorMessage, log } from "./log.ts";
import type { SsrfGuard } from "./ssrf.ts";

export const VERSION = "0.1.0";
export const TOOL_SEPARATOR = "__";
const MAX_TOOL_NAME = 128; // MCP spec limit for tool names
const MAX_DESCRIPTION = 2_000; // keeps a hostile/verbose upstream from flooding LLM context
const MAX_BACKOFF_MS = 60_000;

export interface ServerRow {
  id: number;
  slug: string;
  name: string;
  url: string;
  auth_type: "none" | "bearer" | "header";
  auth_header_name: string | null;
  credential_enc: string | null;
  enabled: boolean;
  managed: boolean;
  created_at: Date;
  updated_at: Date;
}

export type UpstreamStatus = "connected" | "unreachable" | "disabled" | "connecting";

interface Upstream {
  row: ServerRow;
  client?: Client;
  status: UpstreamStatus;
  lastError?: string;
  lastCheckedAt?: Date;
  tools: Tool[];
  failures: number;
  nextCheckAt: number;
  checking?: Promise<void>;
}

/** What the API shows about a server. Never includes the credential. */
export interface ServerView {
  id: number;
  slug: string;
  name: string;
  url: string;
  authType: ServerRow["auth_type"];
  authHeaderName: string | null;
  hasCredential: boolean;
  enabled: boolean;
  managed: boolean;
  status: UpstreamStatus;
  lastError: string | null;
  lastCheckedAt: string | null;
  tools: { name: string; exposedAs: string; title?: string; description?: string; readOnly?: boolean }[];
}

/** Connection settings for a server, with the credential in plaintext (only ever in memory). */
export interface ConnectionSpec {
  slug: string;
  url: string;
  authType: ServerRow["auth_type"];
  authHeaderName?: string | null;
  credential?: string | null;
}

export class UpstreamManager extends EventEmitter {
  #db: Db;
  #box: CredentialBox;
  #guard: SsrfGuard;
  #intervalMs: number;
  #timeoutMs: number;
  #upstreams = new Map<number, Upstream>();
  #timer?: NodeJS.Timeout;
  #toolsSignature = "";

  constructor(db: Db, box: CredentialBox, guard: SsrfGuard, opts: { intervalMs: number; timeoutMs: number }) {
    super();
    this.#db = db;
    this.#box = box;
    this.#guard = guard;
    this.#intervalMs = opts.intervalMs;
    this.#timeoutMs = opts.timeoutMs;
  }

  async start(): Promise<void> {
    await this.tick();
    this.#timer = setInterval(() => void this.tick(), this.#intervalMs);
  }

  async stop(): Promise<void> {
    clearInterval(this.#timer);
    await Promise.allSettled([...this.#upstreams.values()].map((u) => u.client?.close()));
  }

  /** Re-read the registry and run due health checks. Never throws. */
  async tick(): Promise<void> {
    try {
      await this.#sync();
      const now = Date.now();
      await Promise.allSettled(
        [...this.#upstreams.values()].filter((u) => u.row.enabled && now >= u.nextCheckAt).map((u) => this.#check(u)),
      );
    } catch (err) {
      log({ msg: "upstream tick failed", error: errorMessage(err) });
    }
    this.#emitIfToolsChanged();
  }

  /** Called after an admin edit: pick up the change and check that server right away. */
  async refresh(serverId?: number): Promise<void> {
    await this.#sync();
    const u = serverId === undefined ? undefined : this.#upstreams.get(serverId);
    if (u?.row.enabled) await this.#check(u);
    this.#emitIfToolsChanged();
  }

  async #sync(): Promise<void> {
    const { rows } = await this.#db.query<ServerRow>("SELECT * FROM servers ORDER BY slug");
    const seen = new Set<number>();
    for (const row of rows) {
      seen.add(row.id);
      const existing = this.#upstreams.get(row.id);
      if (!existing) {
        this.#upstreams.set(row.id, {
          row,
          status: row.enabled ? "connecting" : "disabled",
          tools: [],
          failures: 0,
          nextCheckAt: 0,
        });
      } else if (existing.row.updated_at.getTime() !== row.updated_at.getTime()) {
        // Settings changed (URL, credential, enabled…): drop the old connection, start over.
        void existing.client?.close();
        Object.assign(existing, {
          row,
          client: undefined,
          status: row.enabled ? "connecting" : "disabled",
          lastError: undefined,
          tools: [],
          failures: 0,
          nextCheckAt: 0,
        });
      }
    }
    for (const [id, u] of this.#upstreams) {
      if (!seen.has(id)) {
        void u.client?.close();
        this.#upstreams.delete(id);
      }
    }
  }

  #check(u: Upstream): Promise<void> {
    // Coalesce concurrent checks of the same server (tick + admin refresh + failed call).
    u.checking ??= this.#doCheck(u).finally(() => (u.checking = undefined));
    return u.checking;
  }

  async #doCheck(u: Upstream): Promise<void> {
    const row = u.row;
    try {
      if (!u.client) u.client = await this.#connect(this.#specFor(row), this.#timeoutMs);
      const { tools } = await u.client.listTools(undefined, { timeout: this.#timeoutMs });
      if (u.row !== row) return; // row was replaced while we were checking
      if (u.status !== "connected") log({ msg: "upstream connected", server: row.slug, tools: tools.length });
      Object.assign(u, { status: "connected", lastError: undefined, tools, failures: 0 });
      u.nextCheckAt = Date.now() + this.#intervalMs - 500;
    } catch (err) {
      if (u.row !== row) return;
      const reason = describeError(err, row.slug, this.#timeoutMs);
      if (u.status !== "unreachable" || u.lastError !== reason) {
        log({ msg: "upstream unreachable", server: row.slug, error: reason });
      }
      void u.client?.close();
      u.failures += 1;
      Object.assign(u, { client: undefined, status: "unreachable", lastError: reason, tools: [] });
      // First failure: retry in 3s (a brand-new pod's NetworkPolicy rules take a
      // moment to be programmed). Then 15s, 30s, 60s, 60s… so a dead server isn't hammered.
      const delay = u.failures === 1 ? 3_000 : Math.min(this.#intervalMs * 2 ** (u.failures - 2), MAX_BACKOFF_MS);
      u.nextCheckAt = Date.now() + delay - 500;
      if (delay < this.#intervalMs) {
        setTimeout(() => {
          if (u.row === row && u.status === "unreachable") this.recheckSoon(row.id);
        }, delay).unref();
      }
    } finally {
      u.lastCheckedAt = new Date();
    }
  }

  #specFor(row: ServerRow): ConnectionSpec {
    return {
      slug: row.slug,
      url: row.url,
      authType: row.auth_type,
      authHeaderName: row.auth_header_name,
      credential: row.credential_enc ? this.#box.decrypt(row.credential_enc, row.slug) : null,
    };
  }

  async #connect(spec: ConnectionSpec, timeoutMs: number): Promise<Client> {
    // The upstream credential is injected here, server-side. It is never sent
    // to the gateway's own clients, and their API keys are never sent upstream.
    const headers: Record<string, string> = {};
    if (spec.credential && spec.authType === "bearer") headers.authorization = `Bearer ${spec.credential}`;
    if (spec.credential && spec.authType === "header" && spec.authHeaderName) {
      headers[spec.authHeaderName] = spec.credential;
    }
    const client = new Client({ name: "urumi-gateway", version: VERSION });
    // guard.fetch checks every address actually connected to (src/ssrf.ts);
    // redirects are refused so a server can't bounce us somewhere internal.
    const transport = new StreamableHTTPClientTransport(new URL(spec.url), {
      requestInit: { headers, redirect: "error" },
      fetch: this.#guard.fetch,
    });
    try {
      await withTimeout(client.connect(transport), timeoutMs, `connect timed out after ${timeoutMs / 1000}s`);
      return client;
    } catch (err) {
      void client.close();
      throw err;
    }
  }

  /** Try a server's settings without saving them (dashboard "Test connection"). */
  async test(spec: ConnectionSpec): Promise<{ ok: true; tools: string[] } | { ok: false; error: string }> {
    let client: Client | undefined;
    try {
      client = await this.#connect(spec, this.#timeoutMs);
      const { tools } = await client.listTools(undefined, { timeout: this.#timeoutMs });
      return { ok: true, tools: tools.map((t) => t.name) };
    } catch (err) {
      return { ok: false, error: describeError(err, spec.slug, this.#timeoutMs) };
    } finally {
      void client?.close();
    }
  }

  // ---- Read side ----------------------------------------------------------

  views(): ServerView[] {
    return [...this.#upstreams.values()]
      .sort((a, b) => a.row.slug.localeCompare(b.row.slug))
      .map((u) => this.#view(u));
  }

  view(serverId: number): ServerView | undefined {
    const u = this.#upstreams.get(serverId);
    return u && this.#view(u);
  }

  #view(u: Upstream): ServerView {
    const { row } = u;
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      url: row.url,
      authType: row.auth_type,
      authHeaderName: row.auth_header_name,
      hasCredential: row.credential_enc !== null,
      enabled: row.enabled,
      managed: row.managed,
      status: row.enabled ? u.status : "disabled",
      lastError: u.lastError ?? null,
      lastCheckedAt: u.lastCheckedAt?.toISOString() ?? null,
      tools: u.tools.map((t) => ({
        name: t.name,
        exposedAs: exposedName(row.slug, t.name),
        title: t.title,
        description: t.description,
        readOnly: t.annotations?.readOnlyHint,
      })),
    };
  }

  /**
   * The aggregated tool list: every tool of every enabled + connected server,
   * renamed `<slug>__<tool>` so names can never collide and the model can see
   * which server a tool belongs to.
   */
  aggregatedTools(): Tool[] {
    const out: Tool[] = [];
    for (const u of [...this.#upstreams.values()].sort((a, b) => a.row.slug.localeCompare(b.row.slug))) {
      if (!u.row.enabled || u.status !== "connected") continue;
      for (const t of u.tools) {
        const name = exposedName(u.row.slug, t.name);
        if (name.length > MAX_TOOL_NAME) continue;
        const description = `[${u.row.name}] ${t.description ?? ""}`.slice(0, MAX_DESCRIPTION);
        out.push({
          name,
          title: t.title ? `${t.title} (${u.row.name})` : undefined,
          description,
          inputSchema: t.inputSchema,
          annotations: t.annotations,
        });
      }
    }
    return out;
  }

  /**
   * Resolve an exposed tool name to its upstream. Slugs can't contain "__",
   * so splitting at the first separator is unambiguous.
   */
  resolve(exposed: string):
    | { ok: true; server: ServerRow; tool: string; client: Client }
    | { ok: false; outcome: "denied" | "unreachable"; server?: ServerRow; error: string } {
    const i = exposed.indexOf(TOOL_SEPARATOR);
    const slug = i > 0 ? exposed.slice(0, i) : "";
    const tool = i > 0 ? exposed.slice(i + TOOL_SEPARATOR.length) : "";
    const u = [...this.#upstreams.values()].find((x) => x.row.slug === slug);
    if (!u || !tool) return { ok: false, outcome: "denied", error: `Unknown tool '${exposed}'` };
    if (!u.row.enabled) {
      return { ok: false, outcome: "denied", server: u.row, error: `Server '${slug}' is disabled by an admin` };
    }
    if (u.status !== "connected" || !u.client) {
      return {
        ok: false,
        outcome: "unreachable",
        server: u.row,
        error: `Upstream '${slug}' is unreachable${u.lastError ? `: ${u.lastError}` : ""}`,
      };
    }
    if (!u.tools.some((t) => t.name === tool)) {
      return { ok: false, outcome: "denied", server: u.row, error: `Server '${slug}' has no tool '${tool}'` };
    }
    return { ok: true, server: u.row, tool, client: u.client };
  }

  /** A call failed at the transport level: re-check that server now instead of waiting for the next tick. */
  recheckSoon(serverId: number): void {
    const u = this.#upstreams.get(serverId);
    if (!u?.row.enabled) return;
    void this.#check(u).then(() => this.#emitIfToolsChanged());
  }

  #emitIfToolsChanged(): void {
    const signature = JSON.stringify(this.aggregatedTools());
    if (signature !== this.#toolsSignature) {
      const first = this.#toolsSignature === "";
      this.#toolsSignature = signature;
      if (!first) this.emit("toolsChanged");
    }
  }
}

export function exposedName(slug: string, tool: string): string {
  return `${slug}${TOOL_SEPARATOR}${tool}`;
}

export function isTimeout(err: unknown): boolean {
  return (
    (err instanceof SdkError && err.code === SdkErrorCode.RequestTimeout) ||
    (err instanceof Error && /timed out/i.test(err.message))
  );
}

/** Human-readable reason for the dashboard ("connection refused", "timed out after 5s", "HTTP 401"…). */
export function describeError(err: unknown, slug: string, timeoutMs: number): string {
  if (isTimeout(err)) return `timed out after ${timeoutMs / 1000}s`;
  const msg = errorMessage(err);
  const blocked = /URL blocked: .*/.exec(msg);
  if (blocked) return blocked[0];
  if (/ECONNREFUSED/.test(msg)) return "connection refused";
  if (/ENOTFOUND|EAI_AGAIN/.test(msg)) return "host not found";
  if (/ECONNRESET|socket hang up|UND_ERR_SOCKET/.test(msg)) return "connection reset";
  // The upstream went away mid-request (e.g. its pod was stopping): the SDK reports the closed stream.
  if (/connection closed|other side closed/i.test(msg)) return "connection closed by upstream";
  const status = err instanceof SdkHttpError ? err.status : undefined;
  if (status === 401) return "upstream rejected the credential (HTTP 401)";
  if (status === 403) return "upstream refused access (HTTP 403)";
  if (status === 404) return "no MCP endpoint at this URL (HTTP 404)";
  if (status) return `upstream answered HTTP ${status}`;
  log({ msg: "upstream error (unclassified)", server: slug, error: msg });
  return msg.slice(0, 300);
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(message)), ms))),
  ]).finally(() => clearTimeout(timer));
}
