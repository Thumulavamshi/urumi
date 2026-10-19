// Browser test of the dashboard, driving a real (headless) browser through the
// admin and member flows end to end:
//
//   ADMIN_PASSWORD=… npm run e2e            # uses the installed Edge
//   BROWSER_CHANNEL=chrome SHOTS=./shots npm run e2e
//
// Admin: login (wrong password first), server list/status/tools, test
// connection, add-server form, managed lock, invite. Member (dark mode):
// accept invite, create key, use it from an MCP client, see own audit. Admin:
// audit filter, disable/enable a server, revoke key, disable member. Plus
// phone width and logout. Leaves one disabled ui-member-… user behind.
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const BASE = (process.env.GATEWAY_URL ?? "http://app.127.0.0.1.nip.io").replace(/\/+$/, "");
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@urumi.local";
const PASS = process.env.ADMIN_PASSWORD;
if (!PASS) throw new Error("set ADMIN_PASSWORD (kubectl -n platform get secret platform-gateway -o jsonpath={.data.admin-password} | base64 -d)");
const SHOTS = process.env.SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? `  -> ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
};
const visible = (loc, ms = 10000) => loc.first().waitFor({ state: "visible", timeout: ms }).then(() => true, () => false);
const shot = (page, name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });

// playwright-core downloads no browser: it drives an installed Edge/Chrome.
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL ?? "msedge", headless: true });
const consoleErrors = [];
async function newPage(dark = false) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: dark ? "dark" : "light" });
  const page = await ctx.newPage();
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
  page.on("pageerror", (e) => consoleErrors.push(e.message));
  page.on("dialog", (d) => d.accept());
  return page;
}

// ---- Admin
const admin = await newPage();
await admin.goto(BASE + "/");
await admin.getByLabel("Email").fill(ADMIN_EMAIL);
await admin.getByLabel("Password").fill("wrong-password");
await admin.getByRole("button", { name: "Sign in" }).click();
check("wrong password shows error", await visible(admin.getByRole("alert").filter({ hasText: "invalid email or password" }), 5000));
await admin.getByLabel("Password").fill(PASS);
await admin.getByRole("button", { name: "Sign in" }).click();
await admin.getByRole("heading", { name: "Servers" }).waitFor();
await admin.getByText("3 of 3 connected").waitFor({ timeout: 10000 }).catch(() => {});
check("servers page: 3 of 3 connected", await admin.getByText("3 of 3 connected").isVisible());
check("managed badge shown", (await admin.getByText("managed", { exact: true }).count()) === 3);
await admin.locator("section.server", { hasText: "WooCommerce" }).getByRole("button", { name: /tools/ }).click();
check("woo tools expand with prefixed names", await admin.getByText("woo__list_orders").isVisible());
await shot(admin, "01-servers-admin");

// Test button on a server
await admin.locator("section.server", { hasText: "Currency FX" }).getByRole("button", { name: "Test" }).click();
check("server test shows tools", await visible(admin.getByText(/Test: connected, 3 tools/), 10000));

// Add-server form: test a bad URL, then cancel
await admin.getByRole("button", { name: "Add server" }).click();
await admin.getByLabel("Slug (tool prefix)").fill("broken");
await admin.getByLabel("Display name").fill("Broken");
await admin.getByLabel(/MCP endpoint URL/).fill("http://nothing-here.tools.svc.cluster.local/mcp");
await admin.getByRole("button", { name: "Test connection" }).click();
const testErr = admin.locator("dialog .error");
await testErr.waitFor({ timeout: 15000 }).catch(() => {});
check("add-server test connection shows reason", /host not found|unreachable|timed out|refused/.test((await testErr.textContent().catch(() => "")) ?? ""), await testErr.textContent().catch(() => null));
await admin.getByLabel("Authentication").selectOption("header");
check("header auth asks for header name + credential", (await admin.getByLabel("Header name").isVisible()) && (await admin.getByLabel(/Credential/).isVisible()));
await shot(admin, "02-add-server");
await admin.getByRole("button", { name: "Cancel" }).click();

// Edit managed server: connection fields locked
await admin.locator("section.server", { hasText: "Follow-up Notes" }).getByRole("button", { name: "Edit" }).click();
check("managed server: URL locked in edit form", await admin.getByLabel(/MCP endpoint URL/).isDisabled());
await admin.getByRole("button", { name: "Cancel" }).click();

// Invite a member
const email = `ui-member-${Date.now()}@example.com`;
await admin.getByRole("link", { name: "Team" }).click();
await admin.getByRole("button", { name: "Invite member" }).click();
await admin.getByLabel("Email").fill(email);
await admin.getByLabel("Name").fill("UI Member");
await admin.getByRole("button", { name: "Create invite link" }).click();
const inviteUrl = (await admin.locator("dialog .codebox code").textContent())?.trim();
check("invite link shown", !!inviteUrl?.includes("/invite/"), inviteUrl);
await shot(admin, "03-invite-link");
await admin.getByRole("button", { name: "Done" }).click();
check("new member listed as invite pending", await admin.locator("section.user", { hasText: email }).getByText("invite pending").isVisible());

// ---- Member (dark mode, to check the theme too)
const member = await newPage(true);
await member.goto(inviteUrl);
await member.getByRole("heading", { name: "Join the team" }).waitFor();
check("invite page shows email", await member.getByText(email).isVisible());
await member.getByLabel(/^Password/).fill("member-pass-123");
await member.getByLabel("Confirm password").fill("member-pass-123");
await member.getByRole("button", { name: "Set password and sign in" }).click();
await member.getByRole("heading", { name: "My API keys" }).waitFor();
check("member lands on API keys after accepting", true);
check("member has no Team nav", (await member.getByRole("link", { name: "Team" }).count()) === 0);
await member.getByLabel("New key name").fill("ui laptop");
await member.getByRole("button", { name: "Create key" }).click();
const key = (await member.locator("dialog .codebox code").first().textContent())?.trim();
check("key shown once with mcpg_ prefix", !!key?.startsWith("mcpg_"), key);
check("Claude Code snippet shown", await member.locator("dialog").getByText(/claude mcp add --transport http/).isVisible());
await shot(member, "04-new-key-dark");
await member.getByRole("button", { name: "I've copied it" }).click();
check("key list shows prefix only", (await member.locator("table").textContent())?.includes(key.slice(0, 9)) && !(await member.locator("table").textContent())?.includes(key));

await member.getByRole("link", { name: "Servers" }).click();
check("member: no Add server / Edit buttons", (await member.getByRole("button", { name: "Add server" }).count()) === 0 && (await member.getByRole("button", { name: "Edit" }).count()) === 0);

// The member's key used by an MCP client (plain JSON-RPC, stateless)
const rpc = (method, params) =>
  fetch(BASE + "/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }).then(async (r) => ({ status: r.status, text: await r.text() }));
const call = await rpc("tools/call", { name: "fx__convert_currency", arguments: { amount: 100, from: "USD", to: "EUR" } });
check("member key works from an MCP client", call.status === 200 && call.text.includes("total_to"), call);

await member.getByRole("link", { name: "Audit log" }).click();
await member.getByText("fx__convert_currency").first().waitFor({ timeout: 8000 }).catch(() => {});
check("member audit shows own call", await member.getByText("fx__convert_currency").first().isVisible());
check("member audit has no user filter", (await member.getByLabel("User").count()) === 0);
await shot(member, "05-audit-member-dark");

// ---- Admin: audit filter by that member, disable/enable a server, revoke key
await admin.getByRole("link", { name: "Audit log" }).click();
await admin.getByLabel("User").selectOption({ label: email });
await admin.getByText("fx__convert_currency").first().waitFor({ timeout: 8000 }).catch(() => {});
const auditRows = await admin.locator("tbody tr").count();
check("admin audit filtered to the member", auditRows >= 1 && (await admin.locator("tbody").textContent()).includes(email), auditRows);
await shot(admin, "06-audit-admin");

await admin.getByRole("link", { name: "Servers" }).click();
const fxCard = admin.locator("section.server", { hasText: "Currency FX" });
await fxCard.getByRole("button", { name: "Disable" }).click();
await fxCard.getByText("Disabled", { exact: true }).waitFor({ timeout: 8000 }).catch(() => {});
check("disable fx -> badge Disabled", await fxCard.getByText("Disabled", { exact: true }).isVisible());
const denied = await rpc("tools/call", { name: "fx__convert_currency", arguments: { amount: 1, from: "USD", to: "EUR" } });
check("disabled fx refuses the member's call", denied.text.includes("disabled"), denied.text.slice(0, 200));
await fxCard.getByRole("button", { name: "Enable" }).click();
await fxCard.getByText("Connected", { exact: true }).waitFor({ timeout: 15000 }).catch(() => {});
check("enable fx -> Connected again", await fxCard.getByText("Connected", { exact: true }).isVisible());

await admin.getByRole("link", { name: "Team" }).click();
const card = admin.locator("section.user", { hasText: email });
check("team shows the member's key", await card.getByText("ui laptop").isVisible());
await card.getByRole("button", { name: "Revoke" }).click();
await card.getByText("No active API keys").waitFor({ timeout: 8000 }).catch(() => {});
check("admin revokes member key", await card.getByText("No active API keys").isVisible());
const revoked = await rpc("tools/list", {});
check("revoked key rejected by /mcp", revoked.status === 401, revoked.status);
await shot(admin, "07-team");

// Disable the member -> their dashboard session ends
await card.getByRole("button", { name: "Disable" }).click();
await card.getByText("disabled", { exact: true }).waitFor({ timeout: 8000 }).catch(() => {});
await member.reload();
check("disabled member is logged out", await visible(member.getByRole("heading", { name: "Sign in" }), 8000));

// Used invite link is dead
await member.goto(inviteUrl);
check("used invite link rejected", await visible(member.getByRole("heading", { name: "Invite not valid" }), 8000));

// Mobile layout: no horizontal scroll
await admin.setViewportSize({ width: 390, height: 844 });
await admin.getByRole("link", { name: "Servers" }).click();
const overflow = await admin.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
check("phone width: no horizontal page scroll", overflow <= 0, overflow);
await shot(admin, "08-mobile");

await admin.getByRole("button", { name: "Log out" }).click();
check("logout -> sign in page", await visible(admin.getByRole("heading", { name: "Sign in" }), 8000));

check("no console errors", consoleErrors.filter((e) => !/401|Failed to load resource/.test(e)).length === 0, consoleErrors);
await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
