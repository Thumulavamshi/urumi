// End-to-end check with a real MCP client:
//   MCP_URL=http://localhost:8080/mcp MCP_AUTH_TOKEN=... node scripts/smoke.ts [--write]
// Lists tools, lists products and today's orders; with --write also creates a
// product and flips an order's status back and forth.
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const url = new URL(process.env.MCP_URL ?? "http://localhost:8080/mcp");
const token = process.env.MCP_AUTH_TOKEN ?? "";
const write = process.argv.includes("--write");

const client = new Client({ name: "woo-mcp-smoke", version: "0.1.0" });
await client.connect(
  new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${token}` } } }),
);

const text = (r: Awaited<ReturnType<typeof client.callTool>>) =>
  (r.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("\n");

async function call(name: string, args: Record<string, unknown> = {}) {
  const started = Date.now();
  const r = await client.callTool({ name, arguments: args });
  console.log(`\n### ${name} ${JSON.stringify(args)} -> ${r.isError ? "ERROR" : "ok"} (${Date.now() - started} ms)`);
  console.log(text(r).slice(0, 1500));
  return r;
}

const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => `${t.name}${t.annotations?.readOnlyHint ? " (read-only)" : ""}`).join(", "));

await call("list_products", { per_page: 5 });
await call("list_orders", { date: "today" });
await call("get_order", { id: 999999 }); // expected: clean isError result
await call("create_product", { name: "x", regular_price: "abc" }); // expected: schema validation error

if (write) {
  const created = await call("create_product", { name: `Smoke Test ${new Date().toISOString().slice(11, 19)}`, regular_price: 9.99 });
  const orders = await call("list_orders", { per_page: 1 });
  const id = JSON.parse(text(orders)).orders[0]?.id;
  if (id) {
    await call("update_order_status", { id, status: "on-hold", note: "smoke test" });
    await call("update_order_status", { id, status: "processing" });
    await call("get_order", { id });
  }
  void created;
}

await client.close();
