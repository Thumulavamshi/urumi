# Implementation Plan — WooCommerce Hosting + Team MCP Gateway on Kubernetes

Source: `Urumi AI FDE Internship.pdf` (Round 1). Timebox: 2 weeks. Rule from the brief:
**a working core beats an unfinished bonus** — Phases 0–8 are the core; Phase 9+ only after the
Definition-of-Done (DoD) demo runs end to end.

---

## Key decisions (made up front, documented in `docs/design.md` later)

| Area | Decision | Why |
|---|---|---|
| Local K8s | **k3d** (k3s in Docker) | Same distro as the VPS (k3s) → same Traefik ingress, same `local-path` storage class, same NetworkPolicy controller. Minimal values diff. |
| Packaging | **Helm only**, two releases: `store` (ns `store`) and `platform` (ns `platform`) | The `store` chart (WP + MariaDB + setup Job + Woo MCP) is the exact unit the multi-store bonus would stamp out per namespace. |
| Local domains | `*.127.0.0.1.nip.io` (e.g. `shop.127.0.0.1.nip.io`, `app.127.0.0.1.nip.io`) | Resolves everywhere (browser, Node, Claude Code) with no hosts-file edits. Prod swaps to real DNS via values. |
| Language | **TypeScript** for Woo MCP, gateway, other MCP servers; **React + Vite** dashboard | Official MCP TS SDK has first-class Streamable HTTP server *and* client. One language across the stack. |
| Gateway DB | **PostgreSQL** (in-cluster, PVC) | Users, hashed API keys, server registry, encrypted upstream creds, audit log. Survives multi-replica later (stand-out #7). |
| Store ↔ MCP | **WooCommerce REST API v3** over the in-cluster Service | Stable, versioned, validated by WooCommerce itself; no exec into pods (WP-CLI would need pod-exec RBAC). |
| Tool collisions | Always namespace: `<serverSlug>__<toolName>` (e.g. `woo__list_orders`) | Deterministic, never changes when a new server is added; the model sees which server a tool belongs to. |
| API keys | Random 32-byte token, prefix `mcpg_`, store **SHA-256 hash** + short display prefix; shown once | Fast lookup per request, revocable, never recoverable from DB. |
| Upstream creds | Encrypted at rest (AES-256-GCM, key from a K8s Secret); only decrypted inside gateway | Never sent to browser/MCP client (API returns `hasCredential: true` only). |
| LLM for chat | Provider-agnostic adapter; default to a free/cheap tier (Gemini / Groq / Claude Haiku) | Brief grades the tool loop, not answer quality. Key lives in a K8s Secret. |

---

## Target repo layout

```
.
├── charts/
│   ├── store/                 # WordPress + MariaDB + setup Job + woo-mcp
│   ├── platform/              # gateway + dashboard + postgres + extra MCP servers
│   ├── values-local.yaml      # (per chart: values-local.yaml / values-prod.yaml)
│   └── values-prod.yaml
├── services/
│   ├── woo-mcp/               # Phase 2 — our WooCommerce MCP server (TS)
│   ├── gateway/               # Phase 3/6 — backend: REST API + MCP aggregator + chat agent
│   ├── dashboard/             # Phase 5 — React UI (served by nginx)
│   └── mcp-extra/             # Phase 4 — two additional upstream MCP servers
├── scripts/                   # cluster-up, build-and-import images, seed users, demo helpers
├── docs/
│   ├── design.md              # System design & tradeoffs
│   └── threat-model.md
├── PLAN.md
└── README.md
```

---

## Phase 0 — Foundations (Day 1, half day)

- [x] Install `k3d` and `helm` (Docker + kubectl already present).
- [x] `scripts/cluster-up.sh`: create k3d cluster with ports 80/443 mapped to the load balancer, a local registry (`k3d registry create`) so we can push our images.
- [x] `git init`, repo skeleton above, `.gitignore`, `.env.example` (no real secrets ever committed).
- [x] Verify Traefik ingress works with a throwaway `whoami` on `test.127.0.0.1.nip.io`.

**Exit:** empty cluster + ingress reachable from the browser.

## Phase 1 — WooCommerce store on Kubernetes (Days 1–2)

Own Helm chart `charts/store` (no Bitnami — keeps it explainable and their images changed licensing):

- [x] **MariaDB 11.8** StatefulSet + PVC + headless Service; root/user passwords in a Secret (Helm-generated with `lookup` so upgrades don't rotate them; `resource-policy: keep`).
- [x] **WordPress** Deployment from a **custom image** (`images/wordpress`: official `wordpress:7.1.3-php8.3-apache` + pinned WooCommerce 11.2.1, Storefront 4.6.2, wp-cli 2.12.0). Only `wp-content/uploads` on a PVC; code is immutable (`DISALLOW_FILE_MODS`). Salts from a Secret.
- [x] **Setup Job** (same image, Helm post-install/post-upgrade hook, idempotent — verified on re-run):
  - `wp core install`, activate WooCommerce + Storefront, permalinks, timezone
  - currency/address, **Cash on Delivery** (`enable_for_virtual`), shipping disabled, onboarding + coming-soon skipped
  - seed 3 products (first install only)
  - REST API key **from the Helm-generated `store-wc-api` Secret**, owned by a `shop_manager` user `mcp-bot` (not admin)
- [x] Ingress `shop.127.0.0.1.nip.io`; `WP_HOME`/`WP_SITEURL` from values.
- [x] Probes: MariaDB `healthcheck.sh`; WordPress startup/liveness on a static file, readiness on `/wp-login.php`. Requests/limits on everything incl. the Job.
- [x] ⚠ Gotcha confirmed: over plain HTTP WooCommerce needs **OAuth 1.0a**-signed requests — verified working with the Secret's key; wrong secret → 401. Phase 2 MCP server signs requests.
- [x] Verified: Store API checkout with COD → order #13 `processing`; visible via REST; survives deleting both pods.
- [x] **You**: manual browser checkout + see order in WP admin (confirmed 2026-10-14).

**Exit (DoD "Store"):** open storefront → add to cart → checkout with COD → order visible in WP admin. Pod delete → data survives (PVC).

## Phase 2 — WooCommerce MCP server (Days 3–4)

`services/woo-mcp` (Node + `@modelcontextprotocol/sdk`, Streamable HTTP at `/mcp`):

- [ ] Tools (zod input schemas, clear descriptions):
  - `list_products` (search, status, page/per_page)
  - `create_product` (name, regular_price, description?, status=publish)
  - `list_orders` (status, `after`/`before` dates — supports "orders today"), returns compact summaries
  - `get_order` (id) — line items, totals, customer, status
  - `update_order_status` (id, status enum)
- [ ] WC REST client with timeouts, error mapping → MCP `isError: true` with readable messages.
- [ ] Auth: requires a static bearer token (from Secret) that only the gateway holds.
- [ ] `/healthz` (liveness) and `/readyz` (readiness — checks store reachability).
- [ ] Dockerfile (multi-stage, non-root), added to `charts/store` as Deployment + **ClusterIP only, no Ingress**.
- [ ] NetworkPolicy: ingress to woo-mcp only from `platform` namespace gateway pods; WordPress only from woo-mcp + ingress controller; MariaDB only from WordPress + setup Job.
- [ ] Test with MCP Inspector via `kubectl port-forward` (dev only).

**Exit:** Inspector lists 5 tools, `create_product` shows up on the storefront, `list_orders` for today returns a manual order.

## Phase 3 — Gateway backend core (Days 4–7) — the heart of the project

`services/gateway` (Node/TS, Express or Fastify, Postgres via Drizzle/Prisma, migrations on start):

**Data model:** `users(id, email, name, role[admin|member], password_hash, invited_at)`, `api_keys(id, user_id, prefix, hash, created_at, revoked_at, last_used_at)`, `servers(id, slug, name, url, auth_type[none|bearer|header], auth_header_name, credential_enc, enabled, status, last_error, last_checked_at)`, `audit_log(id, user_id, server_id, tool, started_at, duration_ms, outcome, error)`.

- [ ] **Auth**
  - Dashboard: email+password login → httpOnly session cookie (JWT or server session). Invite = admin creates user with one-time invite link/temp password.
  - MCP endpoint: `Authorization: Bearer mcpg_…` → hash → lookup non-revoked key → user. Revocation takes effect on the very next request (no caching, or cache ≤ few seconds).
- [ ] **Upstream manager**
  - One MCP **client** per enabled server (Streamable HTTP client transport), credential injected as header server-side.
  - Health loop (e.g. every 10–15 s): `listTools` with timeout → status `connected` / `unreachable` (+ reason) ; `disabled` if toggled off. Cache tool lists per server.
  - Reconnect with backoff; a dead upstream never blocks others (`Promise.allSettled` + per-call `AbortSignal` timeout).
- [ ] **Aggregated MCP server** at `POST/GET /mcp` (Streamable HTTP, SDK server):
  - `tools/list` → union of cached tools from enabled+connected servers, renamed `slug__tool`, description prefixed with `[server name]`.
  - `tools/call` → parse prefix → route → timeout (e.g. 20 s) → clear error (`Upstream 'woo' timed out after 20s`) → **audit row always written** (success/error/timeout/denied).
  - Emit `notifications/tools/list_changed` when servers are enabled/disabled/added so clients refresh.
- [ ] **Admin REST API** (role-guarded): CRUD servers (credential write-only), enable/disable, test-connection; users/invites; issue/revoke any key; audit log with filters + pagination.
- [ ] **Member REST API**: my profile, generate/revoke my keys, view tools.
- [ ] Bootstrap: first admin from Secret values; WooCommerce server auto-registered on startup from Helm values (URL + token from Secret) → DoD "already registered as first server".
- [ ] Helm: Deployment + Service + Postgres StatefulSet/PVC + Secrets (DB password, session secret, encryption key, LLM key, bootstrap admin). Probes + limits.

**Exit:** with `curl`/Inspector + a member key: tools from woo listed with prefixes, calls routed and audited; revoked key → 401; disabled server → tools gone.

## Phase 4 — Two more upstream MCP servers (Day 7)

Need ≥3 upstreams and a DoD prompt that uses **two servers in one prompt**. Recommendation:

- [ ] `mcp-extra/fx` — currency/utility server (e.g. `convert_currency`, `get_rates`), protected by a **bearer credential** (demos credential storage). Prompt: *"What were today's orders, and what's the total in EUR?"*
- [ ] `mcp-extra/notes` (or shipping/CRM-style) — e.g. `create_note`, `list_notes`, and deliberately also exposes a tool whose bare name collides with woo (e.g. `list_orders` or `search`) to **demo the collision scheme**. Uses a custom header credential.
- [ ] Optionally a third **public remote** server (e.g. a no-auth hosted MCP) to show an external URL — only if network in the demo is reliable.
- [ ] Deployed via the `platform` chart (or own small chart), ClusterIP only, probes/limits.

**Exit:** 3 servers connected; kill one pod → others keep working, dashboard/API shows it unreachable.

## Phase 5 — React dashboard (Days 8–9)

`services/dashboard` (Vite + React + TanStack Query + a light UI kit), served by nginx; Ingress `app.127.0.0.1.nip.io` with `/api` and `/mcp` routed to the gateway (same origin → simple cookies, no CORS).

- [ ] Login / accept-invite pages.
- [ ] **Servers** (admin edit, member read-only): status badges Connected / Unreachable (with reason) / Disabled, expandable tool list, add/edit (URL, auth type, credential — write-only field), enable/disable, delete, "test connection".
- [ ] **Team** (admin): invite member, list users + keys, revoke key, change role.
- [ ] **My API keys**: generate (show once + copy), revoke, plus a ready-to-paste Claude Code / Cursor config snippet (`claude mcp add --transport http gateway https://app…/mcp --header "Authorization: Bearer …"`).
- [ ] **Audit log**: table (user, server, tool, time, duration, outcome), filters, auto-refresh.
- [ ] **Chat** page (Phase 6).

## Phase 6 — Chat agent (Days 9–10)

- [ ] Backend `POST /api/chat` (streamed via SSE): LLM tool loop
  1. fetch tool list **through the gateway as the logged-in user** (same aggregation + filtering)
  2. send tools + history to LLM → if tool calls: execute **through the gateway's MCP routing path under that user's identity** → append results → repeat (max N steps)
  3. stream final answer + tool-call trace
- [ ] Cleanest "acts as the user" story: the chat module is an MCP client to the gateway's own `/mcp` using a short-lived, internal, user-bound token — so it's literally the same path as external clients, and audit attribution is automatic.
- [ ] UI: messages, collapsible "called `woo__list_orders` (args → result, 230 ms)" chips.
- [ ] LLM provider + key from Secret; provider/model selectable via Helm values.

**Exit (DoD "Chat as user A"):** create product via chat → on storefront; place order by hand → "what orders came in today?" returns it; all calls in audit under user A.

## Phase 7 — Kubernetes hardening + production values (Days 10–11)

- [ ] Every workload: readiness + liveness (+ startup for WordPress), requests/limits — audit with a script.
- [ ] NetworkPolicies: default-deny in both namespaces, then explicit allows (ingress-controller → wordpress/dashboard/gateway; gateway → woo-mcp, extras, postgres; egress DNS + LLM API).
- [ ] Containers non-root, read-only root FS where possible, `securityContext` drop ALL caps.
- [ ] SSRF guard on server URLs (block metadata IPs, link-local; allowlist for cluster-internal service URLs since our upstreams live there — document the tradeoff).
- [ ] `values-prod.yaml`: real hostnames, `ingressClassName`, TLS via cert-manager (optional), storage class/size, image registry/tags, secrets via `existingSecret` (created out-of-band, not in values), resource sizes.
- [ ] Deploy to a VPS with k3s (Hetzner/Oracle free tier) using the **same charts** — document the diff.
- [ ] Upgrade/rollback demo: `helm upgrade` with new image tag → `helm rollback`.

## Phase 8 — Docs, rehearsal, demo video (Days 12–13)

- [ ] `README.md`: prerequisites, local setup (one script), VPS setup, placing an order, connecting Claude Code/Cursor/Inspector, using chat, demo users.
- [ ] `docs/design.md`: architecture diagram, aggregation/routing/failure handling, collision scheme, local→prod changes.
- [ ] `docs/threat-model.md`: shared upstream creds (member can *use* but not *read* them — blast radius), why client tokens aren't passed through (confused deputy, token audience), malicious tool descriptions (prompt injection — namespacing, description prefixes, admin-only registration, length limits, display in UI), member-vs-member (can't see others' keys; can see audit? decide), compromised upstream.
- [ ] Full DoD run-through script with **two users** (A = chat, B = Claude Code) — rehearse, then record covering the 6 required video sections.

## Phase 9+ — Stand-outs / bonus (only if core is done; Day 14 / buffer)

Ranked by value-per-effort given this architecture:

1. **Tool permissions** (stand-out #2) — per-role allow rules (members read-only on woo writes); filter in `tools/list` + reject in `tools/call`. Cheap because routing is already centralized.
2. **Observability** (#8) — Prometheus `/metrics` (calls, errors, latency per server) + reason strings already captured.
3. **Production VPS** (#1) — partly done in Phase 7.
4. **Handling many tools** (#4) — `search_tools` + `call_tool` meta-tools mode for the chat agent.
5. **Multi-store bonus** — `store` chart is already per-namespace; gateway gains a provisioner (Helm SDK / K8s API, RBAC-limited) with status tracking, quotas, NetworkPolicies, auto-registration as `store-<name>__…`.

---

## Day-by-day at a glance

| Days | Phase |
|---|---|
| 1 | 0 Foundations · 1 Store (start) |
| 2 | 1 Store (setup Job, COD, API key) |
| 3–4 | 2 Woo MCP server |
| 4–7 | 3 Gateway core |
| 7 | 4 Extra MCP servers |
| 8–9 | 5 Dashboard |
| 9–10 | 6 Chat agent |
| 10–11 | 7 Hardening + VPS |
| 12–13 | 8 Docs + demo video |
| 14 | Buffer / stand-outs |

## DoD checklist (tick during rehearsal)

- [ ] Storefront checkout (COD) → order in WP admin
- [ ] User A chat: create product → on storefront
- [ ] Manual order → User A chat "orders today" returns it
- [ ] User B Claude Code with only URL + key → sees all enabled tools, orders question works
- [ ] User B one prompt using two upstream servers
- [ ] Revoke B's key → next call rejected
- [ ] Disable a server → tools gone in chat and external client
- [ ] Kill an upstream pod → others fine, dashboard shows Unreachable
- [ ] Every call above in audit log with correct user
