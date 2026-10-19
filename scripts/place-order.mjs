// Place a Cash-on-Delivery order as a shopper would, through the store's public
// Store API (the same calls the checkout page makes): no admin credentials.
//
//   node scripts/place-order.mjs                    # first in-stock product
//   node scripts/place-order.mjs "Urumi Mug" 2      # product by name, quantity
//   SHOP_URL=https://shop.example.com node scripts/place-order.mjs
const SHOP = (process.env.SHOP_URL ?? "http://shop.127.0.0.1.nip.io").replace(/\/+$/, "");
const [nameQuery, qtyArg] = process.argv.slice(2);
const api = `${SHOP}/wp-json/wc/store/v1`;

// The Store API ties a cart to a Cart-Token and protects writes with a Nonce,
// both handed out on the first cart read.
const first = await fetch(`${api}/cart`);
if (!first.ok) throw new Error(`store not reachable: HTTP ${first.status}`);
const headers = {
  "content-type": "application/json",
  "cart-token": first.headers.get("cart-token"),
  nonce: first.headers.get("nonce"),
};

const products = await (await fetch(`${api}/products?per_page=50${nameQuery ? `&search=${encodeURIComponent(nameQuery)}` : ""}`)).json();
const product = products.find((p) => p.is_purchasable && p.is_in_stock);
if (!product) throw new Error(`no purchasable product${nameQuery ? ` matching "${nameQuery}"` : ""}`);

const add = await fetch(`${api}/cart/add-item`, {
  method: "POST",
  headers,
  body: JSON.stringify({ id: product.id, quantity: Number(qtyArg ?? 1) }),
});
if (!add.ok) throw new Error(`add to cart failed: ${await add.text()}`);

const address = {
  first_name: "Demo",
  last_name: "Shopper",
  address_1: "1 Market Street",
  city: "Hyderabad",
  state: "TS",
  postcode: "500001",
  country: "IN",
  email: "shopper@example.com",
  phone: "9999999999",
};
const checkout = await fetch(`${api}/checkout`, {
  method: "POST",
  headers,
  body: JSON.stringify({ billing_address: address, shipping_address: address, payment_method: "cod" }),
});
const order = await checkout.json();
if (!checkout.ok) throw new Error(`checkout failed: ${order.message ?? JSON.stringify(order)}`);
console.log(`order #${order.order_id} placed: ${qtyArg ?? 1} x ${product.name} (${order.status})`);
