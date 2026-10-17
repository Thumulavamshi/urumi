// Phase 4 check: three upstreams behind one gateway endpoint.
//
//   ADMIN_PASSWORD=… node scripts/upstreams-e2e.ts
//
// 1. woo, fx and notes are connected; the colliding bare name `list_orders`
//    shows up twice, once per server prefix.
// 2. The demo prompt "today's orders, and the total in EUR" as the tool calls
//    an agent would make: woo__list_orders -> fx__convert_currency, then a note.
// 3. Failure isolation: scale fx to 0 -> fx calls fail with a clear reason, the
//    API shows it unreachable, woo and notes keep working; scale back -> recovers.
// Uses a temporary admin API key (revoked at the end). Needs kubectl access.
import { execFileSync } from "node:child_process";
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

let cookie = "";
async function api(method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
  const res = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0]!;
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

const text = (r: any): string => r.content?.find((c: any) => c.type === "text")?.text ?? "";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const kubectl = (...args: string[]) => execFileSync("kubectl", args, { encoding: "utf8" });

async function serverStatus(slug: string): Promise<any> {
  return ((await api("GET", "/api/servers")).data as any[]).find((s) => s.slug === slug);
}
async function waitForStatus(slug: string, status: string, timeoutMs: number): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let s: any;
  while (Date.now() < deadline) {
    s = await serverStatus(slug);
    if (s?.status === status) return s;
    await sleep(1000);
  }
  return s;
}

check("admin login", (await api("POST", "/api/auth/login", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD })).status === 200);
const created = await api("POST", "/api/me/keys", { name: "upstreams-e2e" });
check("temporary key created", created.status === 201, created.data);
const key: string = created.data.key;

const client = new Client({ name: "upstreams-e2e", version: "0" });
await client.connect(
  new StreamableHTTPClientTransport(new URL(BASE + "/mcp"), { requestInit: { headers: { authorization: `Bearer ${key}` } } }),
);

try {
  // ---- 1. Three servers, namespaced tools
  for (const slug of ["woo", "fx", "notes"]) {
    const s = await serverStatus(slug);
    check(`${slug} connected (${s?.authType} auth, ${s?.tools.length} tools)`, s?.status === "connected" && s.hasCredential, s);
  }
  const tools = (await client.listTools()).tools.map((t) => t.name);
  check("collision: woo__list_orders and notes__list_orders both listed", tools.includes("woo__list_orders") && tools.includes("notes__list_orders"), tools);
  check("every tool is <slug>__<tool>", tools.every((t) => /^(woo|fx|notes)__/.test(t)), tools);

  // ---- 2. "What were today's orders, and what's the total in EUR?"
  const today = await client.callTool({ name: "woo__list_orders", arguments: { date: "today" } });
  check("woo__list_orders(today)", !today.isError, text(today));
  let orders = JSON.parse(text(today)).orders as { id: number; total: string; currency: string }[];
  if (orders.length === 0) {
    console.log("      (no orders today; using the latest orders instead)");
    orders = JSON.parse(text(await client.callTool({ name: "woo__list_orders", arguments: { per_page: 5 } }))).orders;
  }
  check("store has orders to convert", orders.length > 0);
  const amounts = orders.map((o) => Number(o.total));
  const fx = await client.callTool({
    name: "fx__convert_currency",
    arguments: { amount: amounts, from: orders[0]!.currency, to: "EUR" },
  });
  const fxResult = JSON.parse(text(fx));
  const expected = Math.round(amounts.reduce((a, b) => a + b, 0) * fxResult.rate * 100) / 100;
  check(`fx__convert_currency: ${fxResult.total_from} ${fxResult.from} = ${fxResult.total_to} EUR`, !fx.isError && fxResult.total_to === expected, fxResult);

  const note = await client.callTool({
    name: "notes__create_note",
    arguments: { text: `EUR total of ${orders.length} order(s): ${fxResult.total_to}`, order_id: orders[0]!.id, tags: ["e2e"] },
  });
  check("notes__create_note (custom-header upstream)", !note.isError, text(note));
  const withNotes = JSON.parse(text(await client.callTool({ name: "notes__list_orders", arguments: { tag: "e2e" } })));
  check("notes__list_orders is the notes tool, not woo's", withNotes.orders.some((o: any) => o.order_id === orders[0]!.id), withNotes);
  await client.callTool({ name: "notes__delete_note", arguments: { id: JSON.parse(text(note)).created.id } });

  // ---- 3. Kill one upstream: the others keep working
  kubectl("-n", "tools", "scale", "deploy/tools-fx", "--replicas=0");
  kubectl("-n", "tools", "wait", "--for=delete", "pod", "-l", "app.kubernetes.io/name=fx", "--timeout=60s");
  const down = await client.callTool({ name: "fx__convert_currency", arguments: { amount: 1, from: "USD", to: "EUR" } });
  check("fx down: call fails with a clear reason", down.isError === true && /unreachable|timed out/.test(text(down)), text(down));
  const fxView = await waitForStatus("fx", "unreachable", 20_000);
  check(`API shows fx unreachable ("${fxView?.lastError}")`, fxView?.status === "unreachable" && !!fxView.lastError, fxView);
  const stillTools = (await client.listTools()).tools.map((t) => t.name);
  check("fx tools hidden while down, others still listed", !stillTools.some((t) => t.startsWith("fx__")) && stillTools.includes("woo__list_orders") && stillTools.includes("notes__list_notes"), stillTools);
  const wooOk = await client.callTool({ name: "woo__list_products", arguments: { per_page: 1 } });
  const notesOk = await client.callTool({ name: "notes__list_notes", arguments: { limit: 1 } });
  check("woo and notes keep working", !wooOk.isError && !notesOk.isError, [text(wooOk), text(notesOk)]);
  check("gateway still ready", (await fetch(BASE + "/api/auth/me", { headers: { cookie } })).status === 200);
} finally {
  kubectl("-n", "tools", "scale", "deploy/tools-fx", "--replicas=1");
}

const back = await waitForStatus("fx", "connected", 90_000);
check("fx back: reconnected after scale-up", back?.status === "connected", back);
const again = await client.callTool({ name: "fx__convert_currency", arguments: { amount: 10, from: "USD", to: "INR" } });
check("fx calls work again", !again.isError, text(again));

const audit = (await api("GET", "/api/audit?limit=100")).data.items as any[];
const mine = audit.filter((a) => a.userEmail === ADMIN_EMAIL);
check("audit: fx outage recorded as unreachable", mine.some((a) => a.server === "fx" && a.outcome === "unreachable"), mine.slice(0, 5));
check("audit: notes calls recorded", mine.some((a) => a.server === "notes" && a.outcome === "success"));

await client.close();
check("temporary key revoked", (await api("DELETE", `/api/keys/${created.data.id}`)).status === 200);

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
