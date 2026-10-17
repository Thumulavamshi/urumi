// End-to-end check of the gateway, as two real users would use it.
//
//   GATEWAY_URL=http://app.127.0.0.1.nip.io ADMIN_EMAIL=… ADMIN_PASSWORD=… npm run e2e
//
// Admin invites a member, the member accepts and creates an API key, then an
// MCP client using only URL + key lists and calls tools. Then: disable server
// => list_changed + tools gone; revoke key => rejected; audit attributes it all.
// Creates a fresh member per run; read-only against the store.
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const BASE = (process.env.GATEWAY_URL ?? "http://app.127.0.0.1.nip.io").replace(/\/+$/, "");
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@urumi.local";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) throw new Error("set ADMIN_PASSWORD (kubectl -n platform get secret platform-gateway -o jsonpath={.data.admin-password} | base64 -d)");

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? `  -> ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}

/** Minimal cookie-jar HTTP client for the REST API. */
class Api {
  cookie = "";
  async req(method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
    const res = await fetch(BASE + path, {
      method,
      headers: { "content-type": "application/json", ...(this.cookie ? { cookie: this.cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) this.cookie = setCookie.split(";")[0]!;
    const text = await res.text();
    return { status: res.status, data: text ? JSON.parse(text) : null };
  }
}

async function mcpClient(key: string): Promise<Client> {
  const client = new Client({ name: "e2e", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(BASE + "/mcp"), { requestInit: { headers: { authorization: `Bearer ${key}` } } }),
  );
  return client;
}

const text = (r: any): string => r.content?.find((c: any) => c.type === "text")?.text ?? "";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- Admin logs in, sees the bootstrap server
const admin = new Api();
check("admin login", (await admin.req("POST", "/api/auth/login", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD })).status === 200);
check("wrong password rejected", (await new Api().req("POST", "/api/auth/login", { email: ADMIN_EMAIL, password: "nope" })).status === 401);
check("API needs login", (await new Api().req("GET", "/api/servers")).status === 401);

const servers = (await admin.req("GET", "/api/servers")).data as any[];
const woo = servers.find((s) => s.slug === "woo");
check("woo server registered + connected", woo?.status === "connected", woo);
check("credential never returned", !JSON.stringify(servers).includes("credential_enc") && woo?.hasCredential === true);

// ---- Admin invites member B; B accepts and creates a key
const email = `member-${Date.now()}@example.com`;
const invite = await admin.req("POST", "/api/users", { email, name: "Member B", role: "member" });
check("invite created", invite.status === 201 && typeof invite.data.inviteUrl === "string", invite.data);
const token = String(invite.data.inviteUrl).split("/invite/")[1]!;

const member = new Api();
check("invite lookup", (await member.req("GET", `/api/invites/${token}`)).data?.email === email);
check("accept invite", (await member.req("POST", `/api/invites/${token}/accept`, { password: "member-pass-123" })).status === 200);
check("invite is single-use", (await new Api().req("POST", `/api/invites/${token}/accept`, { password: "x".repeat(12) })).status === 404);
check("member is logged in", (await member.req("GET", "/api/auth/me")).data?.role === "member");
check("member can't edit servers", (await member.req("PATCH", `/api/servers/${woo.id}`, { enabled: false })).status === 403);
check("member can't list users", (await member.req("GET", "/api/users")).status === 403);

const created = await member.req("POST", "/api/me/keys", { name: "claude code" });
check("member key created (shown once)", created.status === 201 && created.data.key?.startsWith("mcpg_"), created.data);
const key: string = created.data.key;
const listed = (await member.req("GET", "/api/me/keys")).data as any[];
check("key list has prefix, not the key", listed.length === 1 && !JSON.stringify(listed).includes(key));

// ---- MCP client with only URL + key
check("MCP without key -> 401", (await fetch(BASE + "/mcp", { method: "POST" })).status === 401);
const client = await mcpClient(key);
let listChanged = 0;
client.setNotificationHandler("notifications/tools/list_changed", () => {
  listChanged++;
});

const tools = (await client.listTools()).tools.map((t) => t.name);
check("tools are namespaced", tools.includes("woo__list_orders") && tools.every((t) => t.includes("__")), tools);

const products = await client.callTool({ name: "woo__list_products", arguments: { per_page: 3 } });
check("woo__list_products routed", !products.isError && text(products).includes("products"), text(products));
const orders = await client.callTool({ name: "woo__list_orders", arguments: { date: "today" } });
check("woo__list_orders(today) routed", !orders.isError, text(orders));
const bad = await client.callTool({ name: "nope__tool", arguments: {} });
check("unknown tool -> clear error", bad.isError === true && text(bad).includes("Unknown tool"), text(bad));
const upstreamErr = await client.callTool({ name: "woo__get_order", arguments: { id: 999999 } });
check("upstream tool error passed through", upstreamErr.isError === true, text(upstreamErr));

// ---- Disable the server => list_changed + tools gone + call refused
check("admin disables woo", (await admin.req("PATCH", `/api/servers/${woo.id}`, { enabled: false })).status === 200);
await sleep(500);
check("list_changed notification received", listChanged >= 1, listChanged);
const afterDisable = (await client.listTools()).tools.map((t) => t.name);
check("disabled server's tools gone", !afterDisable.some((n) => n.startsWith("woo__")), afterDisable);
const disabledCall = await client.callTool({ name: "woo__list_products", arguments: {} });
check("call to disabled server refused", disabledCall.isError === true && text(disabledCall).includes("disabled"), text(disabledCall));
check("admin re-enables woo", (await admin.req("PATCH", `/api/servers/${woo.id}`, { enabled: true })).status === 200);
check("re-enabled server reconnects", (await client.listTools()).tools.some((t) => t.name === "woo__list_orders"));

// ---- Audit
const audit = (await admin.req("GET", `/api/audit?limit=20`)).data.items as any[];
const mine = audit.filter((a) => a.userEmail === email);
check(
  "audit rows attributed to member",
  ["success", "denied", "error"].every((o) => mine.some((a) => a.outcome === o)),
  mine.map((a) => `${a.tool}:${a.outcome}`),
);
const memberAudit = (await member.req("GET", "/api/audit")).data.items as any[];
check("member sees only own audit rows", memberAudit.length > 0 && memberAudit.every((a) => a.userEmail === email));

// ---- CSRF: a cookie-authenticated write from another origin is refused
const csrf = await fetch(BASE + `/api/servers/${woo.id}`, {
  method: "PATCH",
  headers: { cookie: admin.cookie, origin: "http://evil.example", "content-type": "application/json" },
  body: JSON.stringify({ enabled: false }),
});
check("cross-origin write refused", csrf.status === 403, csrf.status);

// ---- Revoke => next request rejected
check("admin revokes member key", (await admin.req("DELETE", `/api/keys/${created.data.id}`)).status === 200);
let revoked = false;
try {
  await client.listTools();
} catch {
  revoked = true;
}
check("revoked key: existing client rejected", revoked);
let reconnect = false;
try {
  await mcpClient(key);
} catch {
  reconnect = true;
}
check("revoked key: new connection rejected", reconnect);
await client.close().catch(() => {});

// Tidy up: disable the throwaway member.
await admin.req("PATCH", `/api/users/${invite.data.id}`, { disabled: true });

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
