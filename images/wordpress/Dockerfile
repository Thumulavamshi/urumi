# Store image: official WordPress + pinned WooCommerce, Storefront and wp-cli.
#
# Code lives in the image, data lives in volumes (MariaDB + wp-content/uploads).
# Upgrading or rolling back the store is therefore a Helm image-tag change, and
# the setup Job never has to download anything from wordpress.org at runtime.
ARG WORDPRESS_TAG=7.1.3-php8.3-apache
FROM wordpress:${WORDPRESS_TAG}

ARG WOOCOMMERCE_VERSION=11.2.1
ARG STOREFRONT_VERSION=4.6.2
ARG WPCLI_VERSION=2.12.0

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends unzip; \
    rm -rf /var/lib/apt/lists/*; \
    curl -fsSL -o /usr/local/bin/wp \
      "https://github.com/wp-cli/wp-cli/releases/download/v${WPCLI_VERSION}/wp-cli-${WPCLI_VERSION}.phar"; \
    chmod +x /usr/local/bin/wp; \
    cd /tmp; \
    curl -fsSL -o woocommerce.zip "https://downloads.wordpress.org/plugin/woocommerce.${WOOCOMMERCE_VERSION}.zip"; \
    curl -fsSL -o storefront.zip "https://downloads.wordpress.org/theme/storefront.${STOREFRONT_VERSION}.zip"; \
    unzip -q woocommerce.zip -d /usr/src/wordpress/wp-content/plugins/; \
    unzip -q storefront.zip -d /usr/src/wordpress/wp-content/themes/; \
    rm -f woocommerce.zip storefront.zip; \
    chown -R www-data:www-data /usr/src/wordpress/wp-content

# Setup scripts used by the Helm setup Job (same image => same code version).
COPY --chown=www-data:www-data setup/ /opt/store-setup/
