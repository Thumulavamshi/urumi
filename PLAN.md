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

## Phase 2 — WooCommerce MCP server (Days 3–4) ✅

`services/woo-mcp` (Node 24 + MCP SDK v2 `@modelcontextprotocol/server`, Streamable HTTP at `/mcp`, stateless):

- [x] Tools: `list_products`, `create_product`, `list_orders` (`date: today|yesterday|YYYY-MM-DD` in store timezone), `get_order`, `update_order_status` (+ optional note). Zod schemas, MCP annotations.
- [x] WC REST client: OAuth 1.0a HMAC-SHA256 signing against the public store URL, timeouts, no redirects, errors → `isError` results.
- [x] Bearer token auth (Secret `store-woo-mcp`, constant-time compare).
- [x] `/healthz`, `/readyz` (store-independent by design), `/status` (store reachability).
- [x] Dockerfile (no build step, non-root uid 1000) in `charts/store`: Deployment + ClusterIP Service, read-only rootfs, caps dropped, no SA token.
- [x] NetworkPolicies: MariaDB ← WordPress/setup; WordPress ← Traefik/woo-mcp; woo-mcp ← `platform` gateway pods only; woo-mcp egress → WordPress + DNS only.
- [x] Verified: smoke client (`scripts/smoke.ts`) locally + in-cluster; raw JSON-RPC from a gateway-labeled pod; blocked from other pods/namespaces/internet; egress to DB/internet blocked.

## Phase 3 — Gateway backend core (Days 4–7) ✅

`services/gateway` (Node 24 + Express 5, `pg` with plain-SQL migrations on start, MCP SDK v2 client + low-level server):

- [x] Data model (`src/migrations/001_init.sql`): users, invites, sessions, api_keys, servers, audit_log.
- [x] **Auth**: dashboard email+password (scrypt) → server-side session in an httpOnly SameSite=Lax cookie (+ Origin check, JSON-only writes); invites = one-time hashed links; API keys `mcpg_…` stored as SHA-256, checked on every request (revocation immediate; live MCP sessions closed too).
- [x] **Upstream manager**: one MCP client per enabled server, registry re-read every 15 s, parallel health checks (5 s timeout), statuses connected / unreachable (+ reason) / disabled, 3 s first retry then backoff, immediate re-check after a transport failure.
- [x] **Aggregated MCP server** at `/mcp`: `slug__tool` names, `[Server]` description prefix, 20 s call timeout, clear errors, an audit row for every call (success/error/timeout/denied/unreachable), `tools/list_changed` pushed to open sessions.
- [x] **Admin REST API**: servers CRUD (credential write-only, AES-256-GCM at rest), enable/disable, test connection (saved or unsaved settings); users invite/role/disable/re-invite; revoke any key; audit with filters + keyset pagination.
- [x] **Member REST API**: me, my keys (create shows key once + Claude Code snippet; revoke), servers + tools read-only, own audit.
- [x] Bootstrap: first admin from Secret; WooCommerce server auto-registered as a managed server from Helm values (token copied from the store namespace via `lookup`).
- [x] Helm `charts/platform`: gateway Deployment + Service, Postgres StatefulSet + PVC, Secrets (keep), Ingress `/api` + `/mcp`, NetworkPolicies (postgres ← gateway; gateway ← Traefik). Probes + limits everywhere. (LLM key Secret comes with Phase 6.)
- [x] Verified: `scripts/e2e.ts` (32 checks) locally and through the Ingress; woo-mcp scaled to 0 → unreachable + clear error, gateway stays Ready, recovers ~13 s after; pod deletes → data survives.

**Exit:** with `curl`/Inspector + a member key: tools from woo listed with prefixes, calls routed and audited; revoked key → 401; disabled server → tools gone. ✅

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
