// The WooCommerce tools exposed over MCP. Each handler calls the REST API and
// returns a compact JSON summary (smaller than raw WooCommerce objects, which
// keeps LLM context small). Store errors come back as `isError: true` results
// with a readable message instead of failing the whole MCP request.
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { WooClient, WooError } from "./woo.ts";

const ORDER_STATUSES = ["pending", "processing", "on-hold", "completed", "cancelled", "refunded", "failed"] as const;

// --- WooCommerce response shapes (only the fields we use) ---------------------
interface WcProduct {
  id: number;
  name: string;
  status: string;
  sku: string;
  price: string;
  regular_price: string;
  sale_price: string;
  stock_status: string;
  stock_quantity: number | null;
  permalink: string;
  date_created: string;
}

interface WcLineItem {
  name: string;
  product_id: number;
  quantity: number;
  total: string;
}

interface WcAddress {
  first_name: string;
  last_name: string;
  email?: string;
  phone?: string;
  address_1: string;
  city: string;
  state: string;
  postcode: string;
  country: string;
}

interface WcOrder {
  id: number;
  number: string;
  status: string;
  currency: string;
  total: string;
  subtotal?: string;
  total_tax: string;
  discount_total: string;
  payment_method_title: string;
  customer_note: string;
  date_created: string;
  date_modified: string;
  billing: WcAddress;
  line_items: WcLineItem[];
}

// --- Formatting -----------------------------------------------------------------
const productSummary = (p: WcProduct) => ({
  id: p.id,
  name: p.name,
  status: p.status,
  sku: p.sku || undefined,
  price: p.price,
  regular_price: p.regular_price,
  sale_price: p.sale_price || undefined,
  stock_status: p.stock_status,
  stock_quantity: p.stock_quantity ?? undefined,
  url: p.permalink,
});

const customerName = (o: WcOrder) => `${o.billing.first_name} ${o.billing.last_name}`.trim() || "guest";

const orderSummary = (o: WcOrder) => ({
  id: o.id,
  number: o.number,
  status: o.status,
  total: o.total,
  currency: o.currency,
  created: o.date_created, // store-local time
  customer: customerName(o),
  email: o.billing.email || undefined,
  payment: o.payment_method_title,
  items: o.line_items.map((i) => `${i.quantity} x ${i.name}`),
});

const orderDetail = (o: WcOrder) => ({
  ...orderSummary(o),
  modified: o.date_modified,
  total_tax: o.total_tax,
  discount_total: o.discount_total,
  customer_note: o.customer_note || undefined,
  billing: o.billing,
  line_items: o.line_items.map((i) => ({ product_id: i.product_id, name: i.name, quantity: i.quantity, total: i.total })),
});

function ok(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function fail(err: unknown) {
  const message =
    err instanceof WooError
      ? `WooCommerce error${err.status ? ` (HTTP ${err.status})` : ""} [${err.code}]: ${err.message}`
      : `Unexpected error: ${(err as Error).message}`;
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

// --- Dates ----------------------------------------------------------------------
/** YYYY-MM-DD of `date` in the given IANA zone / offset. */
function localDate(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function shiftDay(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * WooCommerce's after/before filters are exclusive and interpreted in store
 * time (dates_are_gmt=false), so one calendar day is (prev 23:59:59, next 00:00:00).
 */
function dayRange(day: string): { after: string; before: string } {
  return { after: `${shiftDay(day, -1)}T23:59:59`, before: `${shiftDay(day, 1)}T00:00:00` };
}

// --- Registration -------------------------------------------------------------
export function registerTools(server: McpServer, woo: WooClient): void {
  server.registerTool(
    "list_products",
    {
      title: "List products",
      description:
        "List products in the WooCommerce store, newest first. Optionally filter by a search term or status. Returns id, name, price, stock and URL.",
      inputSchema: z.object({
        search: z.string().optional().describe("Substring to match in product name/description"),
        status: z.enum(["any", "publish", "draft", "pending", "private"]).default("any"),
        per_page: z.number().int().min(1).max(50).default(20),
        page: z.number().int().min(1).default(1),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ search, status, per_page, page }) => {
      try {
        const { data, total } = await woo.request<WcProduct[]>("GET", "/wp-json/wc/v3/products", {
          search,
          status,
          per_page,
          page,
          orderby: "date",
          order: "desc",
        });
        return ok({ total, page, products: data.map(productSummary) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "create_product",
    {
      title: "Create product",
      description:
        "Create a simple product. It is published to the storefront immediately unless status is 'draft'. Price is in the store currency, e.g. \"19.99\".",
      inputSchema: z.object({
        name: z.string().min(1).max(200),
        regular_price: z
          .union([z.string(), z.number()])
          .transform((v) => String(v))
          .refine((v) => /^\d+(\.\d{1,2})?$/.test(v), "price must be a non-negative amount like 19.99")
          .describe("Price in store currency, e.g. 19.99"),
        description: z.string().max(5000).optional(),
        short_description: z.string().max(1000).optional(),
        sku: z.string().max(100).optional(),
        stock_quantity: z.number().int().min(0).optional().describe("If set, stock is managed with this quantity"),
        status: z.enum(["publish", "draft"]).default("publish"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        const body = {
          type: "simple",
          name: args.name,
          regular_price: args.regular_price,
          description: args.description,
          short_description: args.short_description,
          sku: args.sku,
          status: args.status,
          ...(args.stock_quantity !== undefined ? { manage_stock: true, stock_quantity: args.stock_quantity } : {}),
        };
        const { data } = await woo.request<WcProduct>("POST", "/wp-json/wc/v3/products", {}, body);
        return ok({ created: productSummary(data) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "list_orders",
    {
      title: "List orders",
      description:
        "List orders, newest first. Use date='today' (or 'yesterday' / 'YYYY-MM-DD') for orders placed on a calendar day in the store's timezone, or after/before for a custom range. Returns status, total, customer and items per order.",
      inputSchema: z.object({
        date: z
          .string()
          .regex(/^(today|yesterday|\d{4}-\d{2}-\d{2})$/, "use 'today', 'yesterday' or YYYY-MM-DD")
          .optional()
          .describe("Calendar day in store time: 'today', 'yesterday' or YYYY-MM-DD"),
        after: z.string().optional().describe("ISO8601 store-local datetime; orders created after it (ignored if date is set)"),
        before: z.string().optional().describe("ISO8601 store-local datetime; orders created before it (ignored if date is set)"),
        status: z.enum(["any", ...ORDER_STATUSES]).default("any"),
        search: z.string().optional().describe("Match customer name, email or order number"),
        per_page: z.number().int().min(1).max(50).default(20),
        page: z.number().int().min(1).default(1),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ date, after, before, status, search, per_page, page }) => {
      try {
        let range: { after?: string; before?: string } = { after, before };
        let day: string | undefined;
        let timezone: string | undefined;
        if (date) {
          timezone = await woo.timezone();
          const today = localDate(new Date(), timezone);
          day = date === "today" ? today : date === "yesterday" ? shiftDay(today, -1) : date;
          range = dayRange(day);
        }
        const { data, total } = await woo.request<WcOrder[]>("GET", "/wp-json/wc/v3/orders", {
          ...range,
          status,
          search,
          per_page,
          page,
          orderby: "date",
          order: "desc",
        });
        return ok({
          ...(day ? { day, timezone } : {}),
          total,
          page,
          orders: data.map(orderSummary),
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "get_order",
    {
      title: "Get order",
      description: "Get full details of one order by id: status, totals, billing details and line items.",
      inputSchema: z.object({ id: z.number().int().positive().describe("Order id") }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id }) => {
      try {
        const { data } = await woo.request<WcOrder>("GET", `/wp-json/wc/v3/orders/${id}`);
        return ok(orderDetail(data));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "update_order_status",
    {
      title: "Update order status",
      description:
        "Change an order's status (e.g. processing -> completed). Optionally adds a private order note explaining the change. " +
        "refunded, cancelled and failed are final for the customer (WooCommerce records the refund / releases stock): confirm with the user before using them.",
      inputSchema: z.object({
        id: z.number().int().positive().describe("Order id"),
        status: z.enum(ORDER_STATUSES),
        note: z.string().max(1000).optional().describe("Private note added to the order"),
      }),
      // destructive: refunded/cancelled can't be meaningfully undone, so clients should ask first.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ id, status, note }) => {
      try {
        const before = await woo.request<WcOrder>("GET", `/wp-json/wc/v3/orders/${id}`);
        const { data } = await woo.request<WcOrder>("PUT", `/wp-json/wc/v3/orders/${id}`, {}, { status });
        if (note) {
          await woo.request("POST", `/wp-json/wc/v3/orders/${id}/notes`, {}, { note, customer_note: false });
        }
        return ok({ id, previous_status: before.data.status, status: data.status, note_added: Boolean(note) });
      } catch (err) {
        return fail(err);
      }
    },
  );
}
