# Urumi: WooCommerce on Kubernetes + team MCP gateway

A WooCommerce store, a WooCommerce MCP server we wrote ourselves, and a team MCP gateway with a dashboard, all on Kubernetes and deployed with Helm.

- **Store:** WordPress + WooCommerce + MariaDB, with Cash on Delivery checkout.
- **woo-mcp:** our own WooCommerce MCP server (Streamable HTTP), internal to the cluster.
- **fx** and **notes:** two more upstream MCP servers.
- **Gateway:** one MCP endpoint for the whole team. It has users and roles, hashed and revocable API keys, server-side upstream credentials, an audit log and a chat agent.
- **Dashboard:** React UI for servers, team, API keys, the audit log and chat.

```
             ┌─────────────── namespace platform ───────────────┐
 browser ──> │ dashboard (nginx)                                │
 Claude Code │ gateway  /api  /mcp  /api/chat ──> Postgres      │
   ──/mcp──> │   │ users · keys (sha256) · servers (AES-GCM creds) · audit
             └───┼──────────────────────────────────────────────┘
                 │ only gateway pods may connect (NetworkPolicy)
     ┌───────────┴────────── ns store ──────┐   ┌──── ns tools ────┐
     │ woo-mcp ──REST v3──> WordPress ──> MariaDB │ fx      notes    │
     └──────────────────────────────────────┘   └──────────────────┘
 shopper ──> shop.* ──> WordPress (Ingress)
```

| Doc | What's in it |
|---|---|
| [`docs/design.md`](docs/design.md) | System design and tradeoffs, layer by layer: aggregation, routing, failure handling, local vs production |
| [`docs/threat-model.md`](docs/threat-model.md) | Threat model: shared credentials, no token passthrough, malicious tool descriptions, member vs member |
| [`docs/deploy-vps.md`](docs/deploy-vps.md) | Production-like deploy on k3s, and what changes through Helm values |
| [`PLAN.md`](PLAN.md) | Phase-by-phase build log, with what was verified at each step |

## Repository layout

```
charts/store      WordPress + MariaDB + setup Job + woo-mcp   (values-local.yaml / values-prod.yaml)
charts/tools      fx + notes MCP servers                     (values-local.yaml / values-prod.yaml)
charts/platform   gateway + dashboard + Postgres             (values-local.yaml / values-prod.yaml)
images/wordpress  WordPress image with pinned WooCommerce + Storefront + wp-cli
services/woo-mcp     WooCommerce MCP server (TypeScript, MCP SDK, Streamable HTTP)
services/mcp-extra   fx and notes MCP servers
services/gateway     REST API, aggregated MCP endpoint, chat agent (Express + Postgres)
services/dashboard   React + Vite dashboard
scripts/          cluster-up, build-images, deploy-local, place-order, audit-workloads, upgrade-rollback-demo
infra/            k3d cluster config, cert-manager ClusterIssuer
```

## Local setup

**Prerequisites**
- Docker
- [k3d](https://k3d.io) 5.x
- kubectl
- Helm 3
- Node.js 24 (only for the test and helper scripts)
- bash (on Windows, Git Bash)

```bash
scripts/cluster-up.sh          # k3d cluster "urumi" + local registry, ports 80/443 on 127.0.0.1
scripts/build-images.sh        # builds 5 images, pushes to the k3d registry (localhost:5000)

# Optional: the chat agent's LLM key (Groq, free tier). Without it, chat says "not configured".
kubectl create namespace platform
kubectl -n platform create secret generic platform-llm --from-literal=groq-api-key=gsk_...

scripts/deploy-local.sh        # helm upgrade --install store, tools, platform (first run ~3-5 min)
```

**Local domains.** We use [nip.io](https://nip.io): `*.127.0.0.1.nip.io` resolves to `127.0.0.1` everywhere, so there are no hosts-file edits. The k3d load balancer maps ports 80/443 to Traefik.

| URL | What |
|---|---|
| http://shop.127.0.0.1.nip.io | Storefront (`/wp-admin` for WordPress admin) |
| http://app.127.0.0.1.nip.io | Dashboard; the gateway's API is `/api`, its MCP endpoint is `/mcp` |

**Passwords.** None are in the repo. The charts generate them into Secrets on first install, and `lookup` keeps them stable across upgrades.

```bash
# Dashboard admin: admin@urumi.local
kubectl -n platform get secret platform-gateway -o jsonpath='{.data.admin-password}' | base64 -d; echo
# WordPress admin: admin
kubectl -n store get secret store-wordpress -o jsonpath='{.data.admin-password}' | base64 -d; echo
```

## Production-like setup (VPS, k3s)

**Live deployment:** https://shop.139.59.94.246.nip.io (store) and
https://app.139.59.94.246.nip.io (dashboard, `/mcp`). It runs k3s on a
DigitalOcean 2 vCPU / 4 GB droplet, with Let's Encrypt TLS through cert-manager
and only ports 22/80/443 open. The same e2e suites and workload audit pass
against it.

The same three charts, with `values-prod.yaml`. The full walk-through is in [`docs/deploy-vps.md`](docs/deploy-vps.md):
1. Install k3s (it bundles Traefik, `local-path` storage and NetworkPolicy enforcement, like k3d locally).
2. Optionally install cert-manager with the Let's Encrypt issuer and the HTTPS redirect in `infra/`.
3. Push the images to a registry, or stream them into k3s's containerd over SSH (no registry needed).
4. Create the Secrets by hand (`existingSecret`).
5. Run `helm upgrade --install store / tools / platform -f values-prod.yaml`.
6. Verify with `scripts/audit-workloads.mjs` and the e2e suite.

**What changes between local and production.** Only Helm values change: hostnames, TLS, image registry and tag, Secrets strategy, storage class and size, and resources. Templates, probes, NetworkPolicies and security contexts are identical. The table is in `docs/deploy-vps.md`.

**Upgrade and rollback.**

```bash
helm upgrade platform charts/platform -n platform -f charts/platform/values-prod.yaml --set gateway.image.tag=0.1.1
helm history platform -n platform
helm rollback platform <revision> -n platform
```

`scripts/upgrade-rollback-demo.sh` runs this end to end while probing `/healthz` the whole time:
1. A good upgrade.
2. A broken upgrade (image does not exist). The old pod keeps serving, thanks to RollingUpdate with `maxUnavailable: 0` and readiness gates.
3. A rollback.

The last run made 111 probes with 0 failures.

## How to use it

### 1. Place an order (as a shopper)

1. Open the storefront and add a product to the cart.
2. Check out with **Cash on Delivery**. No payment details are needed.
3. The order shows up in `/wp-admin` → WooCommerce → Orders with status *Processing*.

From the command line, the same checkout through the public Store API:

```bash
node scripts/place-order.mjs                 # first in-stock product
node scripts/place-order.mjs "Urumi Mug" 2   # by name and quantity
SHOP_URL=https://shop.example.com node scripts/place-order.mjs
```

### 2. Add a team member

1. Log in to the dashboard as the admin.
2. Go to **Team** → *Invite member*. This gives you a one-time link.
3. The member opens the link and sets a password.

Admins can also change roles, disable users, revoke any key, or issue a key for a member.

### 3. Connect an external MCP client (Claude Code, Cursor, ...)

1. In the dashboard, go to **My API keys** → *Create key*.
2. Copy the key; it is shown once. The dialog also gives ready-to-paste commands:

```bash
claude mcp add --transport http urumi-gateway http://app.127.0.0.1.nip.io/mcp \
  --header "Authorization: Bearer mcpg_..."
```

For Cursor and other clients:

```json
{ "mcpServers": { "urumi-gateway": { "url": "http://app.127.0.0.1.nip.io/mcp",
    "headers": { "Authorization": "Bearer mcpg_..." } } } }
```

The client sees one server whose tools are named `<server>__<tool>`, for example `woo__list_orders`, `fx__convert_currency` and `notes__create_note`. Try:
- *"What orders came in today?"*
- *"What were today's orders, and what's the total in EUR?"* This uses two servers.

Revoking the key in the dashboard rejects the client's next request.

### 4. Use the chat agent

1. Open **Chat** in the dashboard.
2. Ask, for example, *"Create a product called Blue Mug priced at 12.50"* or *"What orders came in today?"*

Each tool call is shown as it happens, and you can expand its arguments and result. The agent acts as the logged-in user:
- It gets that user's tool list.
- It goes through the same router, policy and timeouts as `/mcp`.
- Its calls appear in **Audit log** under that user with `via = chat`.

Before refunding, cancelling or failing an order, or deleting anything, the agent asks for confirmation.

### 5. Admin: manage upstream servers

**Servers** → *Add server*:
1. Enter the URL (Streamable HTTP) and an optional bearer token or custom-header credential. The credential is write-only and encrypted at rest.
2. Test the connection, then save.

From the Servers page you can also:
- enable, disable, edit or delete a server;
- see each server's status: Connected, Unreachable (with the reason) or Disabled;
- see its exposed tools, including the ones marked *admin only*.

## Tests

All of these run against the live cluster:

| Command | Checks |
|---|---|
| `node scripts/audit-workloads.mjs` | Every pod has probes, requests/limits, non-root, dropped caps, seccomp, pinned tags and no SA token. Every namespace is default-deny. Only 3 Ingress backends. |
| `ADMIN_PASSWORD=… npm --prefix services/gateway run e2e` | Two users end to end: invite, keys, MCP list/call, tool policy, SSRF, disable → `list_changed`, revoke, audit, CSRF |
| `ADMIN_PASSWORD=… npm --prefix services/gateway run e2e:upstreams` | 3 upstreams, name collision, two-server prompt, dead upstream isolated and recovered |
| `node services/dashboard/scripts/ui-e2e.mjs` | Dashboard in a real browser (headless Edge), both roles |
| `node services/dashboard/scripts/chat-e2e.mjs` | The definition-of-done chat flow with the real LLM |
| `scripts/upgrade-rollback-demo.sh` | Upgrade, failed upgrade and rollback with zero failed health probes |

## Design decisions

The full reasoning is in [`docs/design.md`](docs/design.md).

- **woo-mcp → store via the WooCommerce REST API v3.**
  - It goes over the in-cluster Service and is signed with OAuth 1.0a, using a `shop_manager` key from a Secret.
  - It is versioned and validated by WooCommerce itself, and needs no pod-exec RBAC, unlike WP-CLI.
  - woo-mcp has no Ingress, and its NetworkPolicy only admits gateway pods.
- **Tool name collisions.** Every tool is always exposed as `<serverSlug>__<tool>`, with its description prefixed by `[Server name]`. Names never change when a new server is added. `woo__list_orders` and `notes__list_orders` both exist on purpose.
- **Failure handling.**
  - **Isolation:** one MCP client per upstream with health checks and backoff. A dead upstream's tools are hidden, and the other servers keep working.
  - **Timeouts:** calls time out after 20 s with a clear error, which is audited as `timeout`, `unreachable` or `error`.
  - **Live updates:** `tools/list_changed` is pushed when a server's tool set changes.
- **Secrets.** All live in Kubernetes Secrets. They are generated by the charts locally and created by hand in production (`existingSecret`). The Groq key is only ever created by hand.

## Stand-out items attempted

| # | Item | Where |
|---|---|---|
| 1 | **Production-like VPS deployment** (k3s, same charts, `values-prod.yaml`) | `docs/deploy-vps.md`, `charts/*/values-prod.yaml`, `infra/letsencrypt-issuer.yaml` |
| 2 | **Tool permissions:** member deny-list, hidden from `tools/list` and chat, rejected and audited if called directly; "admin only" badge in the dashboard | `services/gateway/src/policy.ts`, `toolPolicy` in `charts/platform/values.yaml`, `docs/design.md` (Layer 8) |
| 6 | **Security hardening:** SSRF guard (save time and every connection, DNS-rebinding safe); default-deny NetworkPolicies in all namespaces; non-root, read-only root filesystems, no SA tokens; upstream credentials AES-256-GCM at rest. No component talks to the Kubernetes API, so no RBAC is needed. | `services/gateway/src/ssrf.ts`, `charts/*/templates/networkpolicies.yaml`, `scripts/audit-workloads.mjs`, `docs/design.md` (Layer 7), `docs/threat-model.md` |
| 8 | **Observability (partial):** clear reasons when an upstream is unreachable or a call fails, shown in the dashboard and audit log. There are no metrics endpoint yet. | `services/gateway/src/upstreams.ts`, `log.ts` |
| 9 | **Upgrades and rollback** with zero downtime, scripted and documented | `scripts/upgrade-rollback-demo.sh`, `docs/design.md` (Layer 7), `docs/deploy-vps.md` |

The multi-store bonus was not attempted. The `store` chart is self-contained per namespace, so it is the unit that would be stamped out per store.
