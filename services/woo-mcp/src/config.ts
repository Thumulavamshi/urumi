// All configuration comes from env vars (Kubernetes Secret / Helm values).

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var ${name}`);
  return value;
}

export interface Config {
  port: number;
  /** Where we send requests: the in-cluster WordPress Service. */
  wcBaseUrl: string;
  /** The store's public URL (WP_HOME). WooCommerce verifies OAuth signatures against it. */
  storePublicUrl: string;
  consumerKey: string;
  consumerSecret: string;
  /** Static bearer token the gateway must present. Only the gateway holds it. */
  authToken: string;
  requestTimeoutMs: number;
}

export function loadConfig(): Config {
  return {
    port: Number(process.env.PORT ?? 8080),
    wcBaseUrl: required("WC_BASE_URL").replace(/\/+$/, ""),
    storePublicUrl: required("STORE_PUBLIC_URL").replace(/\/+$/, ""),
    consumerKey: required("WC_CONSUMER_KEY"),
    consumerSecret: required("WC_CONSUMER_SECRET"),
    authToken: required("MCP_AUTH_TOKEN"),
    requestTimeoutMs: Number(process.env.WC_TIMEOUT_MS ?? 10_000),
  };
}
