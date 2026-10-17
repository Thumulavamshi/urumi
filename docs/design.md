# System design and tradeoffs

> Built up phase by phase; sections are filled in as each layer lands.

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
