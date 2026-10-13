<?php
/**
 * WooCommerce configuration, run via `wp eval-file` (WordPress + WooCommerce
 * loaded). Idempotent: options are overwritten to the desired values, the API
 * key is replaced from the Kubernetes Secret, products are seeded only once.
 */

function env_required(string $name): string {
    $value = getenv($name);
    if ($value === false || $value === '') {
        WP_CLI::error("missing required env var {$name}");
    }
    return $value;
}

// --- Store basics ----------------------------------------------------------
update_option('woocommerce_currency', getenv('STORE_CURRENCY') ?: 'USD');
update_option('woocommerce_default_country', getenv('STORE_COUNTRY') ?: 'US:CA');
update_option('woocommerce_store_address', getenv('STORE_ADDRESS') ?: '1 Demo Street');
update_option('woocommerce_store_city', getenv('STORE_CITY') ?: 'San Francisco');
update_option('woocommerce_store_postcode', getenv('STORE_POSTCODE') ?: '94103');

// Skip onboarding and "coming soon" mode (new stores launch hidden otherwise).
update_option('woocommerce_coming_soon', 'no');
update_option('woocommerce_store_pages_only', 'no');
update_option('woocommerce_onboarding_profile', ['skipped' => true]);
update_option('woocommerce_task_list_hidden', 'yes');
update_option('woocommerce_task_list_complete', 'yes');
update_option('woocommerce_allow_tracking', 'no');
update_option('woocommerce_show_marketplace_suggestions', 'no');
update_option('woocommerce_enable_guest_checkout', 'yes');

// No shipping in the demo store. Otherwise any physical product (e.g. one the
// chat agent creates) is blocked at checkout with "no shipping options".
update_option('woocommerce_ship_to_countries', 'disabled');

// Shop / cart / checkout / my-account pages (no-op when they exist).
WC_Install::create_pages();

// --- Payments: Cash on delivery -------------------------------------------
// enable_for_virtual is required because with shipping disabled every cart is
// treated as "needs no shipping", which COD would otherwise refuse.
$cod = (array) get_option('woocommerce_cod_settings', []);
update_option('woocommerce_cod_settings', array_merge(
    [
        'title'              => 'Cash on delivery',
        'description'        => 'Pay with cash upon delivery.',
        'instructions'       => 'Pay with cash upon delivery.',
        'enable_for_methods' => [],
    ],
    $cod,
    ['enabled' => 'yes', 'enable_for_virtual' => 'yes']
));

// --- Service account + REST API key for the MCP server --------------------
// The key belongs to a dedicated shop_manager user, not the admin: it can
// manage products and orders but not plugins, themes or users.
$bot_login = getenv('WC_API_USER') ?: 'mcp-bot';
$bot = get_user_by('login', $bot_login);
if (!$bot) {
    $bot_id = wp_insert_user([
        'user_login' => $bot_login,
        'user_pass'  => wp_generate_password(32),
        'user_email' => $bot_login . '@store.invalid',
        'role'       => 'shop_manager',
    ]);
    if (is_wp_error($bot_id)) {
        WP_CLI::error('could not create API user: ' . $bot_id->get_error_message());
    }
    $bot = get_user_by('id', $bot_id);
} else {
    $bot->set_role('shop_manager');
}

// Consumer key/secret come from a Kubernetes Secret that the MCP server also
// mounts. WooCommerce stores only an HMAC of the consumer key.
global $wpdb;
$consumer_key    = env_required('WC_CONSUMER_KEY');
$consumer_secret = env_required('WC_CONSUMER_SECRET');
$table           = $wpdb->prefix . 'woocommerce_api_keys';
$description     = 'urumi-mcp (managed by Helm)';

$wpdb->delete($table, ['description' => $description]);
$inserted = $wpdb->insert($table, [
    'user_id'         => $bot->ID,
    'description'     => $description,
    'permissions'     => 'read_write',
    'consumer_key'    => wc_api_hash($consumer_key),
    'consumer_secret' => $consumer_secret,
    'truncated_key'   => substr($consumer_key, -7),
]);
if ($inserted === false) {
    WP_CLI::error('could not store API key: ' . $wpdb->last_error);
}
WP_CLI::log("API key for '{$bot_login}' synced (...{$wpdb->insert_id})");

// --- Seed products (first install only) -----------------------------------
if (!get_option('urumi_seeded')) {
    $products = json_decode(getenv('SEED_PRODUCTS') ?: '[]', true) ?: [];
    foreach ($products as $p) {
        $product = new WC_Product_Simple();
        $product->set_name($p['name']);
        $product->set_regular_price((string) $p['price']);
        $product->set_description($p['description'] ?? '');
        $product->set_status('publish');
        $product->save();
        WP_CLI::log("seeded product #{$product->get_id()} {$p['name']}");
    }
    update_option('urumi_seeded', 1);
}

WP_CLI::success('WooCommerce configured');
