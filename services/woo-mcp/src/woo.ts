// Minimal WooCommerce REST v3 client.
//
// Transport: plain HTTP to the in-cluster WordPress Service. Over non-TLS
// connections WooCommerce only accepts OAuth 1.0a one-legged signatures
// (Basic auth is HTTPS-only), so every request is signed with HMAC-SHA256.
// The consumer secret never goes over the wire.
import { createHmac, randomBytes } from "node:crypto";
import type { Config } from "./config.ts";

export class WooError extends Error {
  readonly status: number | undefined;
  readonly code: string;

  constructor(message: string, code: string, status?: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export interface WooResponse<T> {
  data: T;
  total: number | undefined;
}

type Query = Record<string, string | number | boolean | undefined>;

// RFC 3986 encoding, as OAuth 1.0a requires (encodeURIComponent leaves !'()* alone).
function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

export class WooClient {
  private readonly cfg: Config;
  /** Origin WooCommerce uses when it recomputes the signature (see sign()). */
  private readonly signingOrigin: string;
  private tz: { name: string; fetchedAt: number } | undefined;

  constructor(cfg: Config) {
    this.cfg = cfg;
    // WooCommerce rebuilds the signature base string from get_home_url(), i.e.
    // the public store host, with the scheme of the *incoming* request. We
    // call it over in-cluster HTTP, so: http://<public host>.
    this.signingOrigin = `http://${new URL(cfg.storePublicUrl).host}`;
  }

  /** OAuth 1.0a query params for one request. JSON bodies are not signed (per spec, only form bodies are). */
  private sign(method: string, path: string, query: Record<string, string>): Record<string, string> {
    const oauth: Record<string, string> = {
      oauth_consumer_key: this.cfg.consumerKey,
      oauth_nonce: randomBytes(16).toString("hex"),
      oauth_signature_method: "HMAC-SHA256",
      oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    };
    const params = { ...query, ...oauth };
    const normalized = Object.keys(params)
      .sort()
      .map((k) => `${rfc3986(k)}=${rfc3986(params[k]!)}`)
      .join("&");
    const base = [method, rfc3986(this.signingOrigin + path), rfc3986(normalized)].join("&");
    const signature = createHmac("sha256", `${this.cfg.consumerSecret}&`).update(base).digest("base64");
    return { ...params, oauth_signature: signature };
  }

  async request<T>(method: "GET" | "POST" | "PUT", path: string, query: Query = {}, body?: unknown): Promise<WooResponse<T>> {
    const q: Record<string, string> = {};
    for (const [k, v] of Object.entries(query)) if (v !== undefined) q[k] = String(v);

    const signed = this.sign(method, path, q);
    const url = `${this.cfg.wcBaseUrl}${path}?${new URLSearchParams(signed)}`;

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        redirect: "manual", // a redirect would mean misconfiguration; never follow it with credentials
        signal: AbortSignal.timeout(this.cfg.requestTimeoutMs),
      });
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new WooError(`store did not respond within ${this.cfg.requestTimeoutMs / 1000}s`, "store_timeout");
      }
      throw new WooError(`store unreachable: ${(err as Error).message}`, "store_unreachable");
    }

    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      throw new WooError(`store returned non-JSON response (HTTP ${res.status})`, "store_bad_response", res.status);
    }

    if (!res.ok) {
      const e = (json ?? {}) as { code?: string; message?: string };
      throw new WooError(e.message ?? `HTTP ${res.status}`, e.code ?? "store_error", res.status);
    }

    const total = res.headers.get("x-wp-total");
    return { data: json as T, total: total === null ? undefined : Number(total) };
  }

  /** Store timezone (WordPress setting), cached for 5 minutes. Defines "today". */
  async timezone(): Promise<string> {
    if (this.tz && Date.now() - this.tz.fetchedAt < 300_000) return this.tz.name;
    // The REST index is public and includes the site's timezone settings.
    const res = await fetch(`${this.cfg.wcBaseUrl}/wp-json/`, { signal: AbortSignal.timeout(this.cfg.requestTimeoutMs) });
    const index = (await res.json()) as { timezone_string?: string; gmt_offset?: number | string };
    let name = index.timezone_string || "";
    if (!name) {
      // Offset-only setting, e.g. "5.5": map to a fixed-offset zone Intl understands.
      const offset = Number(index.gmt_offset ?? 0);
      const sign = offset >= 0 ? "+" : "-";
      const abs = Math.abs(offset);
      name = `${sign}${String(Math.floor(abs)).padStart(2, "0")}:${String(Math.round((abs % 1) * 60)).padStart(2, "0")}`;
    }
    this.tz = { name, fetchedAt: Date.now() };
    return name;
  }

  /** Lightweight reachability check for /status. */
  async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${this.cfg.wcBaseUrl}/wp-json/`, { signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch {
      return false;
    }
  }
}
