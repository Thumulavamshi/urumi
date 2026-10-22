// Chat acceptance test ("Chat as user A"), in a real browser:
//
//   ADMIN_PASSWORD=… npm run e2e:chat
//
// 1. A fresh member A signs in and asks the chat to create a product
//    -> the product is on the storefront.
// 2. An order for it is placed through the shop (scripts/place-order.mjs)
//    -> "what orders came in today?" answers with that order.
// 3. A two-server question (woo + fx) in the same chat.
// 4. Every tool call is in the audit log under A, via=chat, and A's audit page shows them.
// Uses the real LLM (Groq free tier: a step may wait out a rate limit).
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const BASE = (process.env.GATEWAY_URL ?? "http://app.127.0.0.1.nip.io").replace(/\/+$/, "");
const SHOP = (process.env.SHOP_URL ?? "http://shop.127.0.0.1.nip.io").replace(/\/+$/, "");
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@urumi.local";
const PASS = process.env.ADMIN_PASSWORD;
if (!PASS) throw new Error("set ADMIN_PASSWORD");
const SHOTS = process.env.SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? `  -> ${JSON.stringify(detail).slice(0, 600)}` : ""}`);
  if (!ok) failures++;
};

// ---- Admin (REST) creates member A
let adminCookie = "";
async function adminApi(method, path, body) {
  const res = await fetch(BASE + "/api" + path, {
    method,
    headers: { "content-type": "application/json", ...(adminCookie ? { cookie: adminCookie } : {}), origin: BASE },
    body: body ? JSON.stringify(body) : undefined,
  });
  const c = res.headers.get("set-cookie");
  if (c) adminCookie = c.split(";")[0];
  return res.json();
}
await adminApi("POST", "/auth/login", { email: ADMIN_EMAIL, password: PASS });
const stamp = Date.now().toString(36);
const email = `user-a-${stamp}@example.com`;
const password = "user-a-password-1";
const invite = await adminApi("POST", "/users", { email, name: "User A", role: "member" });
const token = invite.inviteUrl.split("/invite/")[1];
await fetch(`${BASE}/api/invites/${token}/accept`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: BASE },
  body: JSON.stringify({ password }),
});

// ---- Member A in the browser
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL ?? "msedge", headless: true });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
await page.goto(BASE + "/");
await page.getByLabel("Email").fill(email);
await page.getByLabel("Password").fill(password);
await page.getByRole("button", { name: "Sign in" }).click();
await page.getByRole("link", { name: "Chat" }).click();
await page.getByRole("heading", { name: "Chat" }).waitFor();

/** Send a message and wait for the reply to finish; returns the last answer's text and tool names. */
async function ask(text) {
  const before = await page.locator(".bubble-assistant").count();
  await page.getByLabel("Message").fill(text);
  await page.getByRole("button", { name: "Send" }).click();
  await page.locator(".bubble-assistant").nth(before).waitFor();
  // Done when the Send button is back (Stop disappears).
  await page.getByRole("button", { name: "Stop" }).waitFor({ state: "detached", timeout: 180_000 });
  const bubble = page.locator(".bubble-assistant").nth(before);
  const tools = await bubble.locator(".tool-chip code").allTextContents();
  const failed = await bubble.locator(".tool-failed").count();
  const answer = (await bubble.locator(".md").textContent().catch(() => "")) ?? "";
  const error = (await bubble.locator(".error").textContent().catch(() => null)) ?? null;
  console.log(`      > ${text}\n      < [${tools.join(", ")}] ${error ? "ERROR " + error : answer.slice(0, 200).replace(/\s+/g, " ")}`);
  return { tools, failed, answer, error };
}

// 1. Create a product via chat -> on the storefront
const productName = `Chat Mug ${stamp}`;
const created = await ask(`Create a product named "${productName}" priced 14.99`);
check("chat called woo__create_product", created.tools.includes("woo__create_product") && created.failed === 0, created);
const found = await (await fetch(`${SHOP}/wp-json/wc/store/v1/products?search=${encodeURIComponent(productName)}`)).json();
const product = found.find((p) => p.name === productName);
check("product is on the storefront (public Store API)", !!product, found.map((p) => p.name));
if (product) {
  const pageRes = await fetch(product.permalink);
  check(`product page loads: ${product.permalink}`, pageRes.ok && (await pageRes.text()).includes(productName));
  check("price is 14.99", product.prices.price / 10 ** product.prices.currency_minor_unit === 14.99, product.prices);
}
if (SHOTS) await page.screenshot({ path: `${SHOTS}/chat-1-create.png`, fullPage: true });

// 2. Place an order by hand -> "what orders came in today?" returns it
const placeOrder = fileURLToPath(new URL("../../../scripts/place-order.mjs", import.meta.url));
const orderLine = execFileSync("node", [placeOrder, productName], { encoding: "utf8" }).trim();
const orderId = /#(\d+)/.exec(orderLine)?.[1];
console.log(`      (${orderLine})`);
const today = await ask("What orders came in today?");
check("chat called woo__list_orders", today.tools.includes("woo__list_orders"), today.tools);
check(`answer mentions order #${orderId}`, !!orderId && today.answer.includes(orderId), today.answer);

// 3. Two servers in one prompt, in a fresh chat (otherwise the model rightly
//    reuses the order totals it already has and only needs fx).
await page.getByRole("button", { name: "New chat" }).click();
const eur = await ask("What were today's orders, and what's the total in EUR?");
// The model may convert directly or fetch the rate and multiply; either is fine.
check("two servers in one prompt (woo + fx)", eur.tools.some((t) => t.startsWith("woo__")) && eur.tools.some((t) => t.startsWith("fx__")), eur.tools);
check("answer has a EUR amount", /€|EUR/.test(eur.answer), eur.answer);
if (SHOTS) await page.screenshot({ path: `${SHOTS}/chat-2-orders.png`, fullPage: true });

// 4. Audit: everything under A, via chat
const users = await adminApi("GET", "/users");
const userA = users.find((u) => u.email === email);
const audit = await adminApi("GET", `/audit?userId=${userA.id}&limit=100`);
const rows = audit.items;
check("audit rows are attributed to user A", rows.length >= 4 && rows.every((r) => r.userEmail === email), rows.length);
check("all of A's calls are via=chat", rows.every((r) => r.via === "chat"), rows.map((r) => r.via));
for (const tool of ["woo__create_product", "woo__list_orders", "fx__"]) {
  check(`audit has ${tool}* (success)`, rows.some((r) => r.tool.startsWith(tool) && r.outcome === "success"));
}
await page.getByRole("link", { name: "Audit log", exact: true }).click();
await page.getByText("woo__create_product").first().waitFor({ timeout: 10_000 }).catch(() => {});
check("A's audit page shows the chat calls", await page.getByText("woo__create_product").first().isVisible());
if (SHOTS) await page.screenshot({ path: `${SHOTS}/chat-3-audit.png`, fullPage: true });

// Chat survives navigating away and back (sessionStorage)
await page.getByRole("link", { name: "Chat", exact: true }).click();
check("transcript kept when navigating back", (await page.locator(".bubble-user").count()) === 1);

check("no page errors", pageErrors.length === 0, pageErrors);
await browser.close();
await adminApi("PATCH", `/users/${userA.id}`, { disabled: true }); // tidy up the throwaway user
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
