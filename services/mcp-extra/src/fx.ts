// fx: currency conversion MCP server. Protected by a static bearer token
// (FX_AUTH_TOKEN) that only the gateway holds, like woo-mcp.
//
// Rates are a fixed reference table, not a live feed: the demo must not depend
// on a third-party API (and the gateway's egress gets locked down later). The
// table can be replaced without a rebuild via FX_RATES_JSON (units per 1 USD).
import * as z from "zod/v4";
import { bearerToken, fail, ok, required, secretMatches, serve } from "./http.ts";

const DEFAULT_RATES: Record<string, number> = {
  USD: 1,
  EUR: 0.86,
  GBP: 0.75,
  INR: 88.5,
  JPY: 151.2,
  CAD: 1.4,
  AUD: 1.53,
  CHF: 0.8,
  CNY: 7.12,
  SGD: 1.3,
  AED: 3.6725,
};
const DEFAULT_AS_OF = "2026-10-01";

// Currencies without minor units (rounded to whole numbers).
const ZERO_DECIMAL = new Set(["JPY"]);

interface RateTable {
  asOf: string;
  perUsd: Record<string, number>;
}

function loadRates(): RateTable {
  const raw = process.env.FX_RATES_JSON;
  if (!raw) return { asOf: DEFAULT_AS_OF, perUsd: DEFAULT_RATES };
  const parsed = z
    .object({ asOf: z.string(), perUsd: z.record(z.string().regex(/^[A-Z]{3}$/), z.number().positive()) })
    .parse(JSON.parse(raw));
  return { asOf: parsed.asOf, perUsd: { ...parsed.perUsd, USD: 1 } };
}

const port = Number(process.env.PORT ?? 8080);
const token = required("FX_AUTH_TOKEN");
const rates = loadRates();
const codes = Object.keys(rates.perUsd).sort();
const SOURCE = `static reference table as of ${rates.asOf} (not live market data)`;

const currency = z
  .string()
  .transform((s) => s.trim().toUpperCase())
  .refine((c) => c in rates.perUsd, { message: `unsupported currency; supported: ${codes.join(", ")}` });

/** Units of `to` per 1 unit of `from`. */
const rate = (from: string, to: string) => rates.perUsd[to]! / rates.perUsd[from]!;
const round = (value: number, code: string) => {
  const factor = ZERO_DECIMAL.has(code) ? 1 : 100;
  return Math.round(value * factor) / factor;
};
const precise = (n: number) => Number(n.toPrecision(6));

serve({
  name: "fx",
  port,
  challenge: 'Bearer realm="fx"',
  authorize: (req) => secretMatches(bearerToken(req), token),
  register(server) {
    server.registerTool(
      "list_currencies",
      {
        title: "List currencies",
        description: "List the currency codes this server can convert between.",
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async () => ok({ currencies: codes, source: SOURCE }),
    );

    server.registerTool(
      "get_rates",
      {
        title: "Get exchange rates",
        description: "Exchange rates from a base currency to every other supported currency (or just `symbols`).",
        inputSchema: z.object({
          base: currency.default("USD").describe("ISO 4217 code, e.g. USD"),
          symbols: z.array(currency).optional().describe("Limit to these currencies"),
        }),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ base, symbols }) => {
        const targets = (symbols?.length ? symbols : codes).filter((c) => c !== base);
        return ok({
          base,
          rates: Object.fromEntries(targets.map((c) => [c, precise(rate(base, c))])),
          source: SOURCE,
        });
      },
    );

    server.registerTool(
      "convert_currency",
      {
        title: "Convert currency",
        description:
          "Convert an amount (or several amounts, e.g. order totals) from one currency to another. Returns each converted amount, their sum and the rate used.",
        inputSchema: z.object({
          amount: z
            .union([z.number(), z.array(z.number()).min(1).max(500)])
            .describe("One amount, or a list of amounts to convert and sum"),
          from: currency.describe("ISO 4217 code of the amount(s), e.g. USD"),
          to: currency.describe("ISO 4217 code to convert to, e.g. EUR"),
        }),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ amount, from, to }) => {
        const amounts = Array.isArray(amount) ? amount : [amount];
        if (amounts.some((a) => !Number.isFinite(a))) return fail("amounts must be finite numbers");
        const r = rate(from, to);
        const converted = amounts.map((a) => round(a * r, to));
        const total = amounts.reduce((s, a) => s + a, 0);
        return ok({
          from,
          to,
          rate: precise(r),
          ...(amounts.length > 1 ? { amounts, converted } : {}),
          total_from: round(total, from),
          total_to: round(total * r, to),
          source: SOURCE,
        });
      },
    );
  },
});
