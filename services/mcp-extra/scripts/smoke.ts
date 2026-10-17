// Direct check of one server with a real MCP client (bypassing the gateway):
//   MCP_URL=http://localhost:8081/mcp AUTH_HEADER=authorization AUTH_VALUE="Bearer ..." node scripts/smoke.ts
//   MCP_URL=http://localhost:8082/mcp AUTH_HEADER=x-notes-key AUTH_VALUE=... node scripts/smoke.ts
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const url = new URL(process.env.MCP_URL ?? "http://localhost:8080/mcp");
const headers = { [process.env.AUTH_HEADER ?? "authorization"]: process.env.AUTH_VALUE ?? "" };

const client = new Client({ name: "mcp-extra-smoke", version: "0.1.0" });
await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
const info = client.getServerVersion();
const { tools } = await client.listTools();
console.log(`${info?.name}: ${tools.map((t) => t.name).join(", ")}`);

async function call(name: string, args: Record<string, unknown> = {}) {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content as { text?: string }[]).map((c) => c.text ?? "").join("\n");
  console.log(`\n### ${name} ${JSON.stringify(args)} -> ${r.isError ? "ERROR" : "ok"}\n${text.slice(0, 800)}`);
}

if (info?.name === "fx") {
  await call("convert_currency", { amount: [19.99, 45, 12.5], from: "USD", to: "eur" });
  await call("get_rates", { base: "EUR", symbols: ["USD", "INR"] });
  await call("convert_currency", { amount: 1, from: "USD", to: "XYZ" }); // expected: validation error
} else {
  await call("create_note", { text: "Customer asked to deliver after 6pm", order_id: 13, tags: ["Delivery"] });
  await call("list_notes", { order_id: 13 });
  await call("list_orders", {});
  await call("delete_note", { id: "nope" }); // expected: isError
}
await client.close();
