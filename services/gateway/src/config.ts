// All configuration comes from env vars (Kubernetes Secrets / Helm values).

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var ${name}`);
  return value;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`env var ${name} must be a positive integer`);
  return n;
}

/** An upstream server registered from Helm values on every start. */
export interface BootstrapServer {
  slug: string;
  name: string;
  url: string;
  authType: "none" | "bearer" | "header";
  authHeaderName?: string;
  /** Name of the env var holding the credential (mounted from a Secret). */
  credentialEnv?: string;
}

export interface Config {
  port: number;
  databaseUrl: string;
  /** 32-byte key (base64) for encrypting upstream credentials at rest. */
  encryptionKey: Buffer;
  /** Public base URL, e.g. http://app.127.0.0.1.nip.io (used for invite links). */
  publicUrl: string;
  cookieSecure: boolean;
  sessionTtlHours: number;
  inviteTtlHours: number;
  /** Per tools/call timeout towards an upstream. */
  callTimeoutMs: number;
  /** Health check: interval and per-check timeout. */
  healthIntervalMs: number;
  healthTimeoutMs: number;
  bootstrapAdmin?: { email: string; name: string; password: string };
  bootstrapServers: BootstrapServer[];
}

export function loadConfig(): Config {
  const encryptionKey = Buffer.from(required("ENCRYPTION_KEY"), "base64");
  if (encryptionKey.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes, base64-encoded");

  const adminEmail = process.env.BOOTSTRAP_ADMIN_EMAIL;
  const adminPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD;

  return {
    port: int("PORT", 8080),
    databaseUrl: required("DATABASE_URL"),
    encryptionKey,
    publicUrl: required("PUBLIC_URL").replace(/\/+$/, ""),
    cookieSecure: process.env.COOKIE_SECURE === "true",
    sessionTtlHours: int("SESSION_TTL_HOURS", 24 * 7),
    inviteTtlHours: int("INVITE_TTL_HOURS", 72),
    callTimeoutMs: int("CALL_TIMEOUT_MS", 20_000),
    healthIntervalMs: int("HEALTH_INTERVAL_MS", 15_000),
    healthTimeoutMs: int("HEALTH_TIMEOUT_MS", 5_000),
    bootstrapAdmin:
      adminEmail && adminPassword
        ? { email: adminEmail.toLowerCase(), name: process.env.BOOTSTRAP_ADMIN_NAME ?? "Admin", password: adminPassword }
        : undefined,
    bootstrapServers: JSON.parse(process.env.BOOTSTRAP_SERVERS ?? "[]") as BootstrapServer[],
  };
}
