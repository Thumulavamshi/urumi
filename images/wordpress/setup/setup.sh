#!/bin/bash
# Store bootstrap, run by the Helm setup Job (post-install / post-upgrade hook).
# Idempotent: every step either checks state first or converges to the desired
# state, so re-running on each `helm upgrade` is safe and re-syncs config.
#
# Runs as www-data against /usr/src/wordpress inside the same image the web
# pods use, so no shared volume is needed: everything persistent is in MariaDB.
set -euo pipefail

log() { echo "[setup] $*"; }

: "${STORE_URL:?}" "${STORE_TITLE:?}" "${WP_ADMIN_USER:?}" "${WP_ADMIN_PASSWORD:?}" "${WP_ADMIN_EMAIL:?}"

export HOME=/tmp            # wp-cli wants a writable home for its cache
cd /usr/src/wordpress

# Same wp-config the web pods generate: everything comes from env vars/Secrets.
[ -f wp-config.php ] || cp wp-config-docker.php wp-config.php

log "waiting for database ${WORDPRESS_DB_HOST}"
for i in $(seq 1 60); do
  if php /opt/store-setup/wait-db.php; then break; fi
  [ "$i" -eq 60 ] && { log "database not reachable, giving up"; exit 1; }
  sleep 5
done

if wp core is-installed; then
  log "WordPress already installed"
else
  log "installing WordPress"
  wp core install \
    --url="$STORE_URL" --title="$STORE_TITLE" \
    --admin_user="$WP_ADMIN_USER" --admin_password="$WP_ADMIN_PASSWORD" \
    --admin_email="$WP_ADMIN_EMAIL" --skip-email
fi

# Converge settings that may change between releases (URL, title, password).
wp option update home "$STORE_URL" >/dev/null
wp option update siteurl "$STORE_URL" >/dev/null
wp option update blogname "$STORE_TITLE" >/dev/null
wp option update timezone_string "${STORE_TIMEZONE:-UTC}" >/dev/null
wp user update "$WP_ADMIN_USER" --user_pass="$WP_ADMIN_PASSWORD" --skip-email >/dev/null

log "activating theme and WooCommerce"
wp theme activate storefront
wp plugin activate woocommerce

# Pretty permalinks so /wp-json/wc/v3/... works (the .htaccess rewrite rules
# are written by the official image entrypoint in each web pod).
wp rewrite structure '/%postname%/' >/dev/null
wp rewrite flush >/dev/null

log "configuring WooCommerce"
wp eval-file /opt/store-setup/configure.php

log "done: ${STORE_URL}"
