// Thin client for the gateway REST API (same origin, session cookie). Every
// response type here mirrors services/gateway/src/api/*.

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `HTTP ${res.status}`);
  return data as T;
}

export const get = <T>(path: string) => api<T>("GET", path);

// ---- Types --------------------------------------------------------------------

export type Role = "admin" | "member";

export interface Me {
  id: number;
  email: string;
  name: string;
  role: Role;
}

export type AuthType = "none" | "bearer" | "header";
export type ServerStatus = "connected" | "unreachable" | "disabled" | "connecting";

export interface ServerTool {
  name: string;
  exposedAs: string;
  title?: string;
  description?: string;
  readOnly?: boolean;
}

export interface Server {
  id: number;
  slug: string;
  name: string;
  url: string;
  authType: AuthType;
  authHeaderName: string | null;
  hasCredential: boolean;
  enabled: boolean;
  managed: boolean;
  status: ServerStatus;
  lastError: string | null;
  lastCheckedAt: string | null;
  tools: ServerTool[];
}

export type TestResult = { ok: true; tools: string[] } | { ok: false; error: string };

export interface ApiKey {
  id: number;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface NewKey extends ApiKey {
  key: string;
  mcpUrl: string;
  claudeCode: string;
}

export interface User {
  id: number;
  email: string;
  name: string;
  role: Role;
  createdAt: string;
  disabledAt: string | null;
  invitePending: boolean;
  keys: (ApiKey & { userId: number })[];
}

export interface InviteLink {
  inviteUrl: string;
  expiresAt: string;
}

export type Outcome = "success" | "error" | "timeout" | "denied" | "unreachable";

export interface AuditEntry {
  id: number;
  at: string;
  userId: number | null;
  userEmail: string;
  server: string | null;
  tool: string;
  via: "mcp" | "chat";
  durationMs: number;
  outcome: Outcome;
  error: string | null;
}

export interface AuditPage {
  items: AuditEntry[];
  nextBefore: number | null;
}
