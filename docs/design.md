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
