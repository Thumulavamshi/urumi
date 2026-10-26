# System design and tradeoffs

The note is organised by layer, in the order the system was built: store →
WooCommerce MCP server → gateway → extra upstreams → dashboard → chat →
hardening → tool permissions. The last section, "Local → production", covers
what changes between the two environments. The threat model is in
[`threat-model.md`](threat-model.md).

## Layer 1 — Store (`charts/store`, `images/wordpress`)

### What runs (namespace `store`, release `store`)

| Resource | Kind | Exposure | Persistence |
|---|---|---|---|
| `store-mariadb` | StatefulSet (1) + headless Service | cluster-internal only | PVC `data-store-mariadb-0` (volumeClaimTemplate) |
| `store-wordpress` | Deployment (1, `Recreate`) + ClusterIP Service | Ingress `shop.<domain>` | PVC `store-uploads` (only `wp-content/uploads`) |
| `store-setup` | Job (Helm `post-install,post-upgrade` hook) | — | — |
| `store-db`, `store-wordpress`, `store-wc-api` | Secrets | — | generated once, stable across upgrades |

### Decisions

**Code in the image, data in volumes.** WooCommerce, Storefront and wp-cli are
baked into `store-wordpress:<tag>` at pinned versions. Only MariaDB and the
uploads directory are persistent. Consequences:
- Upgrade/rollback of the store = `helm upgrade --set image.tag=…` / `helm rollback`.
  (Database schema migrations are the one thing a rollback can't undo — take a
  DB dump before upgrading WooCommerce major versions.)
- `DISALLOW_FILE_MODS` is on: nobody can install a plugin through wp-admin and
  have it vanish on the next pod restart, and a compromised admin account can't
  drop PHP code onto disk.
- The setup Job never downloads from wordpress.org at runtime, so it works with
  egress locked down.

**Setup as an idempotent Helm hook Job, not an init container.** It runs once
per install/upgrade instead of on every pod start, and it runs from the same
image as the web pods, so it doesn't need to mount the (ReadWriteOnce) uploads
volume — which would pin it to the WordPress pod's node. Every step converges
(check-then-act, or overwrite to the desired value), so re-running it on each
upgrade is safe and re-syncs settings from values/Secrets.

**Secrets split by consumer.** `store-db` (MariaDB + WordPress),
`store-wordpress` (admin password + salts), `store-wc-api` (REST key). The
WooCommerce MCP server will mount only `store-wc-api`, never the DB password.
Secrets are generated with `randAlphaNum` on first install and read back with
`lookup` afterwards, so `helm upgrade` never rotates them. In production,
`existingSecret` points at Secrets created out-of-band and the chart generates
nothing. `store-db` carries `helm.sh/resource-policy: keep`: the MariaDB PVC
survives `helm uninstall`, so its password must too.

**Salts are fixed in a Secret.** The official image generates `wp-config.php`
on each container start; without fixed salts every restart would log everyone
out (and two replicas would disagree on cookies).

**WooCommerce REST key owned by a `shop_manager` service user (`mcp-bot`),
not admin.** It can manage products and orders, not plugins, themes or users —
limiting what the MCP server (and anyone who compromised it) can do.

**How the MCP server will talk to the store: WooCommerce REST API v3** over the
in-cluster Service. Over plain HTTP WooCommerce only accepts OAuth 1.0a-signed
requests (Basic auth is HTTPS-only), so the MCP server signs each request; the
secret never travels on the wire. Alternatives rejected: WP-CLI (needs
`pods/exec` RBAC into the WordPress pod — far broader privilege), direct SQL
(bypasses WooCommerce business logic, stock, hooks).

**Store choices for a demo-friendly checkout.** Shipping is disabled
(`woocommerce_ship_to_countries=disabled`) so any product — including ones the
chat agent creates — can be checked out without configuring shipping zones;
Cash on Delivery therefore needs `enable_for_virtual=yes`. Guest checkout on,
"coming soon" mode off. Store timezone is a value (`store.timezone`) because it
defines what "orders today" means.

### Probes

- MariaDB: `healthcheck.sh --connect --innodb_initialized` (startup/readiness),
  `--connect` (liveness).
- WordPress: startup + liveness hit a **static file** (Apache alive) so a DB
  outage doesn't restart-loop the web tier; readiness hits `/wp-login.php`
  (PHP + DB) so the pod leaves the Service while the DB is down.

### Local domain approach

`*.127.0.0.1.nip.io` — public wildcard DNS that resolves to 127.0.0.1, so the
browser, Node and MCP clients all reach the k3d load balancer on host port 80
without editing the hosts file. In production the same Ingress gets a real
hostname via `ingress.host` (+ cert-manager TLS).

## Layer 2 — WooCommerce MCP server (`services/woo-mcp`)

### Shape

- TypeScript on Node 24, MCP TypeScript SDK **v2** (`@modelcontextprotocol/server`
  + `@modelcontextprotocol/node`). Node runs the `.ts` sources directly (type
  stripping); `tsc` is only a type-checker. No build step, small image, non-root.
- **Streamable HTTP** at `POST /mcp`, **stateless**: each HTTP request gets a
  fresh `McpServer` + transport, no session state. Any replica can serve any
  request; restarts lose nothing. Serves both the 2025-era `initialize`
  handshake (Claude Code, Inspector) and the 2026-07-28 protocol.
- Tools: `list_products`, `create_product`, `list_orders`, `get_order`,
  `update_order_status`. Zod input schemas (invalid input never reaches the
  store), MCP annotations (`readOnlyHint`, `idempotentHint`) so clients and the
  gateway can tell reads from writes. Results are compact JSON summaries rather
  than raw WooCommerce objects, to keep LLM context small.
- "Orders today": `list_orders(date="today")` resolves the calendar day in the
  **store's** timezone (read from the WordPress REST index, cached 5 min), then
  queries WooCommerce with store-local `after`/`before` bounds.

### How it talks to the store, and why

WooCommerce REST API v3 over the in-cluster Service
(`http://store-wordpress.store.svc.cluster.local`). Over plain HTTP WooCommerce
only accepts **OAuth 1.0a one-legged signatures** (HMAC-SHA256 here) — the
consumer secret never travels on the wire. Subtlety: WooCommerce recomputes the
signature from `get_home_url()`, i.e. the store's *public* host, so the client
sends the request to the Service DNS name but signs `http://<public host><path>`
(`STORE_PUBLIC_URL`). Redirects are never followed (`redirect: manual`) so
credentials can't be bounced elsewhere.

Rejected: WP-CLI (needs `pods/exec` into WordPress — cluster-API privileges far
beyond "manage orders"); direct SQL (bypasses WooCommerce logic: stock, hooks,
HPOS/legacy storage differences).

### Failure handling

- Every store call has a timeout (`WC_TIMEOUT_MS`, default 10 s).
- Store errors are returned as MCP tool results with `isError: true` and a
  readable message (`WooCommerce error (HTTP 404) [woocommerce_rest_shop_order_invalid_id]: Invalid ID.`,
  `store did not respond within 10s`, `store unreachable: …`) — the MCP
  request itself succeeds, so a client/LLM can react.
- **Readiness does not depend on the store.** If WordPress is down the MCP
  server stays in the Service and answers with clear tool errors; it only
  disappears (→ gateway shows *Unreachable*) when the MCP pod itself is dead.
  `/status` reports store reachability for debugging.

### Isolation (enforced, and tested)

| Path | Mechanism | Verified |
|---|---|---|
| Internet → MCP | ClusterIP Service, no Ingress | `shop…/mcp` → 404 |
| Other pods → MCP | NetworkPolicy: only `app.kubernetes.io/name=gateway` pods in ns `platform`, port 8080 | other ns / unlabeled pod → refused |
| Gateway → MCP without token | Static bearer token (Secret `store-woo-mcp`), constant-time compare | 401 |
| MCP → MariaDB / internet | Egress NetworkPolicy: only WordPress:80 + DNS | refused |
| MCP → DB password | Only `store-wc-api` Secret mounted | — |
| MCP → Kubernetes API | `automountServiceAccountToken: false` | — |

Container hardening: `runAsNonRoot` (uid 1000), read-only root filesystem, all
capabilities dropped, no privilege escalation, `RuntimeDefault` seccomp.

Observed: kube-router (k3s' NetworkPolicy controller) programs a **new** pod's
IP a second or two after the pod starts, so a brand-new client pod is briefly
refused. The gateway must therefore treat early connection errors as transient
(retry/health loop), not as a permanent failure.

## Layer 3 — Gateway (`services/gateway`, `charts/platform`)

### What runs (namespace `platform`, release `platform`)

| Resource | Kind | Exposure | Persistence |
|---|---|---|---|
| `platform-gateway` | Deployment (1) + ClusterIP Service | Ingress `app.<domain>`: `/api`, `/mcp` | none (only in-memory MCP sessions) |
| `platform-postgres` | StatefulSet (1) + headless Service | cluster-internal; NetworkPolicy: gateway only | PVC `data-platform-postgres-0` |
| `platform-gateway` | Secret | — | encryption key + bootstrap admin password (`keep`) |
| `platform-postgres` | Secret | — | DB password (`keep`) |
| `platform-upstreams` | Secret | — | upstream credentials copied from other namespaces at install time |

### Request flow

```
MCP client ──Bearer mcpg_…──> Traefik ──> gateway /mcp
  1. sha256(key) → api_keys ⋈ users (not revoked, user not disabled)    every request, no cache
  2. tools/list → union of cached tool lists of enabled+connected upstreams, renamed <slug>__<tool>
     tools/call → split at first "__" → that upstream's client → callTool (20 s timeout)
  3. audit_log row (user, key, server, tool, duration, outcome, error)  always, incl. denied/unreachable
gateway ──Bearer <upstream token, decrypted in memory>──> store-woo-mcp (NetworkPolicy: gateway pods only)
```

The caller's API key says *who* is calling and stops at the gateway; the
upstream credential is added by the gateway and never leaves it. Neither is
passed through to the other side (no confused deputy, no token reuse across
audiences).

### Decisions

**Tool naming: always `<slug>__<tool>`**, even without a collision. It's
deterministic (a tool's name never changes because another server was added)
and the model can see which server a tool belongs to. Slugs match
`^[a-z][a-z0-9-]{0,29}$` (no underscores), so splitting at the first `__` is
unambiguous; slugs are immutable because clients remember tool names.
Descriptions get a `[Server name]` prefix and are capped at 2000 chars.

**Upstream manager.** One long-lived MCP client per enabled server. Every 15 s
it re-reads the `servers` table (edits through any replica propagate) and runs
`tools/list` with a 5 s timeout on every enabled server **in parallel**
(`Promise.allSettled`), so one slow or dead upstream never delays the others.
Failure → status `unreachable` with a readable reason (`connection refused`,
`timed out after 5s`, `upstream rejected the credential (HTTP 401)`…), client
dropped, retried after 3 s, then 15/30/60 s backoff. A tool call that fails at
the transport level triggers an immediate re-check. Verified: woo-mcp scaled to
0 → the next call returns `Upstream 'woo' is unreachable: connection refused`
(audited as `unreachable`), the gateway stays Ready, and it reconnects ~13 s
after the pod is back.

**`notifications/tools/list_changed`.** When the exposed tool set changes
(server added/removed/enabled/disabled/down/up), every open MCP session gets a
`list_changed` notification on its GET/SSE stream, so Claude Code or Cursor
refresh their tools without reconnecting. Calls are still checked at call time:
a client with a stale list gets `Server 'woo' is disabled by an admin`.

**MCP sessions.** Clients that `initialize` get a stateful session bound to
their API key (another key can't use that session id). Sessions live in the
replica's memory: with >1 replica the Ingress needs sticky sessions on
`Mcp-Session-Id`, or clients re-initialize on 404. Requests without a session
that aren't `initialize` (2026-07-28-era clients, curl) are served statelessly.
Revoking a key or disabling a user also closes that principal's open sessions.

**Auth.**
- *API keys*: `mcpg_` + 32 random bytes, shown once; the DB stores the SHA-256
  and a display prefix. SHA-256 (not bcrypt) fits 256-bit random secrets and
  allows an indexed lookup on every request.
- *Dashboard*: email + password (scrypt) → opaque session token in an
  `httpOnly`, `SameSite=Lax` cookie (`Secure` when TLS is on). Sessions are
  server-side, so logout/disable is instant. CSRF: SameSite, plus an `Origin`
  check and JSON-only bodies on cookie-authenticated writes.
- *Invites*: the admin creates the user → one-time link (token hashed, 72 h,
  single-use under `SELECT … FOR UPDATE`) → the user sets a password.
- *Roles*: `admin` (servers, users, any key, full audit); `member` (own keys,
  read-only servers/tools, own audit rows).

**Upstream credentials at rest**: AES-256-GCM, key from the `platform-gateway`
Secret, server slug bound in as AAD. The API is write-only for credentials
(`hasCredential: true`). Threat-model note: the gateway must decrypt them to
call upstreams, so a compromised gateway pod exposes them; the DB alone or a DB
backup does not.

**Bootstrap from Helm values.** The first admin (password from the Secret) and
the WooCommerce server are created on start. "Managed" servers converge to the
values on every start (URL/credential); an admin's enable/disable choice is
kept. Secrets can't be referenced across namespaces, so the chart copies the
store's `store-woo-mcp` token into `platform-upstreams` with `lookup` at install
time (install the store first). In production that Secret is created
out-of-band (`values-prod.yaml`).

**Probes.** Gateway readiness = Postgres reachable, deliberately *not* upstream
health. A startup probe covers waiting for Postgres and running migrations.
Postgres: `pg_isready`.

**Migrations**: plain SQL files applied at startup under a Postgres advisory
lock (safe when several replicas start at once).

### Verified (`scripts/e2e.ts`, 32 checks, through the Ingress)

Admin login; wrong password → 401; invite → accept → single-use; a member can't
edit servers or list users; key shown once; `/mcp` without a key → 401; tools
namespaced; calls routed; unknown tool and upstream tool errors → clear
`isError` results; disable server → `list_changed` received, tools gone, calls
refused; re-enable → tools back; audit rows attributed to the member (success,
error, denied); members see only their own rows; cross-origin cookie write →
403; revoke key → the open session *and* a new connection are rejected. Also:
deleting the Postgres and gateway pods loses no users, keys, sessions or audit.

## Layer 4 — Extra upstreams (`services/mcp-extra`, `charts/tools`)

### What runs (namespace `tools`, release `tools`)

| Resource | Purpose |
|---|---|
| `tools-fx` Deployment + ClusterIP Service | Currency conversion MCP server, bearer auth |
| `tools-notes` Deployment + Service + PVC (256Mi) | Follow-up notes MCP server, `X-Notes-Key` header auth |
| `tools-fx` / `tools-notes` Secrets | Generated inbound tokens (key `token`), stable across upgrades |
| NetworkPolicies | Ingress only from `app.kubernetes.io/name=gateway` pods in `platform`; egress: none |

### Decisions

**Why these two.** Together with woo they make the demo prompt span two
servers ("today's orders, total in EUR": `woo__list_orders` →
`fx__convert_currency`) and exercise both credential types the gateway
supports (bearer, custom header). `notes` deliberately exposes `list_orders`,
the same bare name as WooCommerce's, to show why every tool is exposed as
`<slug>__<tool>`.

**One image, two commands.** Both servers share the stateless HTTP shell
(`src/http.ts`: `/mcp`, `/healthz`, `/readyz`, constant-time credential check,
graceful SIGTERM) and differ only in auth and tools. The chart sets
`command: [node, src/fx.ts]` or `[node, src/notes.ts]`.

**Static FX rates.** A fixed table (as-of date in every response, labelled
"not live market data"), overridable from values without a rebuild. A live
rates API would add an outside dependency to the demo and need egress, which
these pods don't have.

**Notes storage.** A JSON file on a ReadWriteOnce volume, rewritten via
temp-file + rename so a crash never leaves it truncated. That forces one
writer: `replicas: 1` and `strategy: Recreate`. Good enough for a demo
upstream; a real one would use a database.

**Own namespace and chart.** Same isolation story as the store: the gateway is
the only thing that can reach them. Their tokens are copied into
`platform-upstreams` at install time (install `tools` before `platform`), and
the servers are registered as managed upstreams in the platform values.

### Verified (`services/gateway/scripts/upstreams-e2e.ts`, 22 checks)

All three upstreams connected; `woo__list_orders` and `notes__list_orders` both
listed; the woo → fx flow returns the correct EUR total; notes written through
the header credential. Scaling fx to 0: the next call fails with "Upstream 'fx'
is unreachable: connection refused", the API shows fx `unreachable`, its tools
disappear from `tools/list`, woo and notes keep working, the gateway stays
ready; after scale-up fx reconnects and the outage shows in the audit log as
`unreachable`. Separately: a pod without the gateway label is blocked from fx,
the notes pod can't reach the internet, and notes survive deleting their pod.

## Layer 5 — Dashboard (`services/dashboard`)

### What runs

| Resource | Purpose |
|---|---|
| `platform-dashboard` Deployment + Service | nginx-unprivileged serving the built SPA on 8080 |
| Ingress path `/` | Everything that isn't `/api` or `/mcp` (longest prefix wins) |
| NetworkPolicy `platform-dashboard` | Ingress only from Traefik; no egress |

### Decisions

**Same origin for UI, API and MCP.** One host, path-routed by the Ingress.
The browser authenticates with the gateway's httpOnly `SameSite=Lax` session
cookie: no tokens in JavaScript or localStorage, no CORS. The gateway's
Origin check plus JSON-only content type covers CSRF for cookie-authed writes.

**The dashboard pod holds nothing.** Static files only: no secrets, no server
code, no outbound traffic. Every permission check lives in the gateway; the UI
only hides what a role can't use (members get no Team page or server edit
buttons, and the API returns 403 if they try anyway).

**Small dependency surface.** React + TanStack Query (caching, polling,
invalidation after mutations) and a 30-line router (`router.tsx`) for five
flat routes; plain CSS with light/dark tokens instead of a component kit.

**Live-ish status without websockets.** Servers poll every 5 s and the audit
log every 5 s (toggleable). That's enough for "kill a pod → badge goes red with
the reason" in the demo, and costs one cheap in-memory read on the gateway.

**Secrets shown exactly once.** New API keys and invite links appear in a
dialog right after creation (with copy buttons and ready-to-paste Claude Code /
Cursor config) and can never be retrieved again; the gateway stores only
hashes. Upstream credentials are write-only form fields.

**Session end handling.** While logged in, any 401 (session expired, user
disabled, logged out elsewhere) re-checks `/api/auth/me` and drops the app to
the login page. Logout does a full reload so no cached data survives.

**nginx hardening.** Non-root, read-only root filesystem (writable `/tmp`
emptyDir), the image's entrypoint scripts skipped, CSP `default-src 'self'`,
`frame-ancestors 'none'`, nosniff; hashed assets cached for a year,
`index.html` never cached (so a deploy is picked up on the next load).

### Verified (`scripts/ui-e2e.mjs`, headless Edge, 32 checks)

Admin: wrong password → error; 3 of 3 servers connected with tools; test
connection; add-server form shows "host not found" for a bad URL; managed
server's URL locked; invite link. Member (dark mode): accepts invite, lands on
keys, creates a key (shown once with snippets), uses it from an MCP client,
sees only their own audit rows, no admin controls. Admin: audit filtered to
that member; disabling fx flips the badge and refuses the member's call;
re-enable reconnects; revoke the member's key → `/mcp` 401; disable the member
→ their open dashboard drops to login; used invite link rejected; no
horizontal scroll at phone width; logout; no console errors.

## Layer 6 — Chat agent (`services/gateway/src/api/chat.ts`, `llm.ts`; dashboard `Chat` page)

### Request flow

```
browser ──POST /api/chat {messages}──> gateway (session cookie → principal = user A)
   ▲                                     │ tools = upstreams.aggregatedTools()
   │ SSE: tool_call / tool_result /      │ loop ≤ 8:
   │      status / message / done        │   Groq chat/completions (messages + tools)
   └─────────────────────────────────────│   tool_calls? → router.call(A, name, args, "chat")
                                         │                  → upstream MCP server
                                         │                  → audit_log row (user A, via=chat)
                                         │   else → final answer
```

### Decisions

**"Acts as the user" in-process.** The plan considered making the chat an MCP
client of the gateway's own `/mcp` with a short-lived internal token. The
`/mcp` handlers are one-liners: `tools/list` → `aggregatedTools()`,
`tools/call` → `router.call(principal, …)`. Calling those same two functions
with the session user as principal gives the identical path (same tool list,
same disabled/unreachable/unknown-tool checks, same timeout, same audit row) without
minting internal tokens or making an HTTP hop to ourselves. Audit rows carry
`via=chat` so the log shows how the call was made.

**Provider: Groq, OpenAI-compatible, plain fetch.** One endpoint and a few
typed fields; switching provider is a base URL + model + key change in values.
The key lives only in the `platform-llm` Secret (created by hand), mounted with
`optional: true`: without it the gateway still starts and chat reports "not
configured".

**Stateless server, transcript in the browser.** Each message sends the
recent transcript (user messages + final answers, last 12 turns); the gateway
keeps no chat state, so any replica can answer and nothing sensitive persists
server-side beyond the audit log.

**Built for a free tier (8k tokens/minute).** Tool schemas lose `$schema`;
tool results are cut to 4,000 characters before going back to the model; on
HTTP 429 the loop waits for the provider's reset time (≤30 s, up to 3 times)
and tells the user ("retrying in 11s…"); a malformed tool call
(`tool_use_failed`) is retried once; one running reply per user.

**Streaming.** SSE over a POST (`fetch` + stream reader; `EventSource` can't
POST). Events are per step, not per token: the interesting part to watch is
which tool ran, with what, and how long it took. Keepalive comments every 15 s;
if the browser goes away the loop and any in-flight tool call are aborted.

**Prompt guardrails.** The system prompt names the user, says calls are
audited under them, explains the `<server>__<tool>` prefixes and tells the
model to use tools rather than guess and to report failures plainly. It's not a
security boundary: what the chat can do is bounded by the tools that user can
reach, exactly like their own MCP client.

**Rendering.** Answers are Markdown (tables are common); a small renderer
builds React elements, never `innerHTML`, and links are http(s) only, so model
or tool output can't inject markup.

### Verified (`services/dashboard/scripts/chat-e2e.mjs`, real browser + real LLM)

Fresh member A, in the dashboard: "Create a product … priced 14.99" →
`woo__create_product` → the product is in the public Store API and its page
loads with the right price. An order placed through the shop
(`scripts/place-order.mjs`) → "What orders came in today?" answers with that
order number. In a new chat, "What were today's orders, and what's the total in
EUR?" → `woo__list_orders` + an `fx__*` tool with the correct total.
Every row in the audit log is user A, `via=chat`, success; A's own audit page
shows them. Also checked by hand: same user twice at once → 429; fx disabled
→ the model says the tool isn't available; a burst → rate-limit retries then
correct answers.

## Layer 7 — Hardening (all three charts, `services/gateway/src/ssrf.ts`)

### Network: default deny, then named paths only

Each namespace has a `default-deny` NetworkPolicy (all pods, in and out), and
every component gets an explicit allow-list on top. Pods may only use the
paths below.

| From | To | Why |
|---|---|---|
| Traefik | wordpress:80, gateway:8080, dashboard:8080 | the public front doors |
| gateway | postgres:5432 | its database |
| gateway | pods in `store`, `tools` on :8080 | in-cluster MCP servers (they further restrict to the gateway) |
| gateway | public IPs :443 | LLM API, internet MCP servers (private ranges carved out) |
| woo-mcp | wordpress:80 | WooCommerce REST API |
| wordpress, setup Job | mariadb:3306 | database |
| wordpress | Traefik :8000/8443, public IPs :80/443 | its own public URL (WP-Cron loopback), payment/shipping APIs |
| everyone above | kube-dns:53 | name resolution |
| mariadb, postgres, dashboard, fx, notes | nothing | they never call out |

Probed from inside the pods (k3s's kube-router rejects with ECONNREFUSED).
- **Gateway:** reaches Postgres, woo-mcp, fx and `api.groq.com`. It cannot
  reach the Kubernetes API, WordPress, MariaDB, 169.254.169.254, the dashboard
  or arbitrary :80.
- **woo-mcp:** reaches only WordPress.
- **fx:** reaches nothing, not even DNS.
- **WordPress:** reaches MariaDB and public :443, but not woo-mcp, the
  gateway, Postgres or the Kubernetes API.

The WordPress→Traefik rule came from a test. Run from a pod, a request to the
node IP is forwarded (DNAT) to the Traefik pod before the policy is checked.
So with only "public IPs" allowed, a store on a VPS couldn't call its own URL,
and WP-Cron would break silently. Allowing exactly the Traefik pods' container
ports fixes it without opening anything else on the node.

### SSRF: two independent layers

Admins type upstream URLs, and the gateway then sends requests to them carrying
stored credentials.

**Application layer (`src/ssrf.ts`)** checks every address a host resolves to:
- **Always refused:** loopback, link-local (including metadata at
  169.254.169.254 and `fd00:ec2::254`), unspecified, multicast and reserved.
  This holds even for allowlisted hosts.
- **Private ranges** (RFC 1918, CGNAT, IPv6 ULA) are refused unless the host
  name is on `gateway.upstreamAllowedHosts`. The default allowlist is
  `*.store.svc.cluster.local` and `*.tools.svc.cluster.local`.
- **IPv4-mapped IPv6** is normalised first, so `::ffff:127.0.0.1` can't slip
  past the IPv4 rules.

The check runs in two places:
- **Before saving:** on create, update and "Test connection", the API returns a
  clear 400.
- **On every connection:** the MCP transport's `fetch` uses an undici `Agent`
  whose `connect.lookup` applies the same rules. This protects the address
  actually dialled, so a name that resolves to a public IP when saved and
  127.0.0.1 later (DNS rebinding, e.g. `127.0.0.1.nip.io`) is still caught.

Redirects are refused, so an upstream can't bounce the gateway somewhere
internal. A blocked tool call is audited as `denied`.

**The tradeoff.** Our own upstreams live in the cluster, so private addresses
can't be refused outright. The allowlist names the namespaces that hold MCP
servers, never `*.svc.cluster.local`, which would include the Kubernetes API
and Postgres. A new in-cluster server namespace needs an entry in
`upstreamAllowedHosts` and in `networkPolicy.gatewayEgress.upstreamNamespaces`.

**Network layer.** The gateway's egress policy (above) is the backstop. For
example, `store-wordpress.store.svc.cluster.local` passes the application check
because its namespace is allowlisted, but the connection is still refused,
because the policy only lets the gateway reach port 8080 in that namespace.

### Pods

All workloads meet these rules:
- non-root, enforced with `runAsNonRoot`;
- `allowPrivilegeEscalation: false` and `capabilities: drop [ALL]`;
- seccomp `RuntimeDefault`;
- no service-account token;
- requests and limits on every container;
- readiness and liveness probes on everything except the Job, plus startup
  probes where startup is slow.

Changes to the store's images in this phase:
- **WordPress** now runs Apache entirely as `www-data`. Port 80 is opened with
  the namespaced `net.ipv4.ip_unprivileged_port_start=0` sysctl instead of a
  capability.
- **MariaDB** starts as `mysql`, instead of root followed by gosu.

Read-only root filesystems:
- **Read-only:** gateway, MCP servers, dashboard, Postgres and MariaDB. Their
  writable paths are `emptyDir` volumes for sockets and `/tmp`.
- **Still writable:** WordPress and its setup Job. The official image's
  entrypoint copies the WordPress code into `/var/www/html` at start; the code
  still comes only from the image, because `DISALLOW_FILE_MODS` is set.

`scripts/audit-workloads.mjs` checks all of this against the live cluster,
reading what is actually running rather than the templates. It also checks:
- each namespace has a default-deny policy;
- there are no NodePort or LoadBalancer Services;
- Ingresses only point at the three public services.

It exits 1 on any failure. Before this phase it reported 17 failures; now it
reports none.

### Upgrades and rollback

The gateway and the dashboard roll with `maxSurge: 1, maxUnavailable: 0`: the
new pod must be Ready before the old one stops.
`scripts/upgrade-rollback-demo.sh` runs three steps:
1. Upgrades to an immutable image tag (the commit).
2. Upgrades to a tag that doesn't exist. `helm upgrade --wait` fails, and the
   old pod keeps serving.
3. Runs `helm rollback` to the good revision, then back to the start.

A probe hits `/healthz` every 0.5 s throughout. Measured result: 111 probes,
0 failures.

## Layer 8 — Tool permissions and confirmations (`services/gateway/src/policy.ts`)

Admins can use every tool. Members can't use the tools listed in
`toolPolicy.memberDeniedTools` (Helm values; exposed names, `*` wildcard). The
default list is `woo__update_order_status` (refunds and cancellations) and
`notes__delete_note`, so a member can't wipe teammates' notes. Members keep
read access and can still create products and notes, which the
chat-as-member test needs. To match the assignment's stricter example, add
`woo__create_product` to the list.

The policy is one check, used on every path:
- **MCP clients:** `tools/list` leaves the denied tools out of the member's list.
- **Chat:** the agent's tool list leaves them out too, so the model never sees
  them.
- **Direct calls:** `ToolRouter.call` rejects a call made anyway, for example
  from a stale tool list or a hand-written request. It's audited as `denied`.
- **Dashboard:** tools are marked "admin only".

Irreversible actions also need confirmation, even for admins. The tool
description and the chat system prompt both require the model to look the
order up, say exactly what will change, and wait for a "yes" in a later
message before setting refunded, cancelled or failed. The tool is annotated
`destructiveHint: true`, so external clients like Claude Code can treat it with
care too. This is a model-level guardrail, not a security boundary; the role
policy is the boundary.

Admins can also issue API keys for a member (`POST /api/users/:id/keys`, the
Team page's "Issue key" button). The key is shown once, to the admin, and acts
as that member: their role and their audit trail.

Verified in `scripts/e2e.ts`:
- The member's list hides the admin-only tools.
- A direct call is rejected and audited as `denied`.
- The admin still sees the tools.
- An issued key works as the member.
- A member can't issue keys.

Checked by hand against the real model: "refund order 18" makes it look the
order up and ask "Shall I go ahead?". "yes, go ahead" then performs the refund.

## Local → production (VPS)

The same three charts run in both places. Only values files change:
`values-local.yaml` locally, and `values-prod.yaml` plus a small per-server
override on the VPS. Templates, probes, NetworkPolicies, security contexts and
the SSRF guard are identical. Reference deploy: k3s on a DigitalOcean
2 vCPU / 4 GB droplet, at https://app.139.59.94.246.nip.io. The step-by-step
guide is in [`deploy-vps.md`](deploy-vps.md).

| Concern | Local (k3d) | Production (k3s on a VPS) |
|---|---|---|
| **DNS** | `*.127.0.0.1.nip.io`, so no hosts file | Real A records, or `*.<ip>.nip.io` (what the reference deploy uses) |
| **Ingress** | Traefik (bundled), plain HTTP | Same Traefik; cert-manager + Let's Encrypt (HTTP-01); HTTP → HTTPS redirect; `COOKIE_SECURE` on |
| **Storage class** | `local-path`, small volumes | `local-path` set explicitly, bigger volumes (10Gi store, 5Gi Postgres); swap for a block-storage class on a multi-node cluster |
| **Secrets** | Generated by the charts on first install (`lookup` keeps them stable) | Created on the server beforehand; charts use `existingSecret`. Nothing secret in values or git. The Groq key is always created by hand. |
| **Images** | `urumi-registry:5000/*:dev` (k3d registry) | Immutable tags (`0.1.0`), from GHCR or streamed into containerd over SSH; `IfNotPresent` |
| **Exposure** | k3d load balancer on 127.0.0.1 | Firewall allows only 22/80/443; the k3s API (6443) is reached through an SSH tunnel |

**Upgrades** use a new immutable tag (`helm upgrade --set gateway.image.tag=…`).
RollingUpdate with `maxUnavailable: 0` keeps the old pod serving until the new
one is Ready. `helm rollback <release> <rev>` goes back. See
`scripts/upgrade-rollback-demo.sh`.

Things found only on the real server:
- cert-manager's HTTP-01 solver pod is blocked by default-deny. The charts now allow Traefik → solver:8089 when TLS is on.
- With a Secure cookie, a login over plain HTTP silently fails, so Traefik redirects HTTP to HTTPS (`infra/traefik-https-redirect.yaml`).
