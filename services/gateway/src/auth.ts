// Who is calling? Two ways in, both resolved against the database on EVERY
// request (no caching), so revoking a key, disabling a user or logging out
// takes effect on the very next request.
//
//   Dashboard / REST API: httpOnly session cookie  -> sessions table
//   MCP clients:          Authorization: Bearer mcpg_… -> api_keys table
import type { NextFunction, Request, Response } from "express";
import type { Db } from "./db.ts";
import { API_KEY_PREFIX, randomToken, sha256 } from "./crypto.ts";

export type Role = "admin" | "member";

export interface User {
  id: number;
  email: string;
  name: string;
  role: Role;
}

/** The identity a request acts as. `apiKeyId` is set when authenticated by API key. */
export interface Principal extends User {
  apiKeyId?: number;
}

declare global {
  namespace Express {
    interface Request {
      principal?: Principal;
    }
  }
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const SESSION_COOKIE = "gw_session";

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

export function bearerToken(req: Request): string | undefined {
  const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "");
  return match?.[1];
}

export async function principalFromApiKey(db: Db, key: string): Promise<Principal | undefined> {
  if (!key.startsWith(API_KEY_PREFIX)) return undefined;
  const { rows } = await db.query<Principal>(
    `SELECT u.id, u.email, u.name, u.role, k.id AS "apiKeyId"
       FROM api_keys k JOIN users u ON u.id = k.user_id
      WHERE k.key_hash = $1 AND k.revoked_at IS NULL AND u.disabled_at IS NULL`,
    [sha256(key)],
  );
  const principal = rows[0];
  if (principal) {
    // Cheap "last used" bookkeeping: at most one write per key per minute.
    void db
      .query(
        `UPDATE api_keys SET last_used_at = now()
          WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
        [principal.apiKeyId],
      )
      .catch(() => {});
  }
  return principal;
}

async function principalFromSession(db: Db, token: string): Promise<Principal | undefined> {
  const { rows } = await db.query<Principal>(
    `SELECT u.id, u.email, u.name, u.role
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now() AND u.disabled_at IS NULL`,
    [sha256(token)],
  );
  return rows[0];
}

export async function createSession(
  db: Db,
  res: Response,
  userId: number,
  opts: { ttlHours: number; secure: boolean },
): Promise<void> {
  const token = randomToken(32);
  await db.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(hours => $3))`,
    [sha256(token), userId, opts.ttlHours],
  );
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true, // not readable from JS => an XSS can't steal it
    sameSite: "lax", // not sent on cross-site POSTs (CSRF), still sent on normal navigation
    secure: opts.secure, // HTTPS-only in production
    path: "/",
    maxAge: opts.ttlHours * 3600_000,
  });
}

export async function destroySession(db: Db, req: Request, res: Response): Promise<void> {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) await db.query("DELETE FROM sessions WHERE token_hash = $1", [sha256(token)]);
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}

/**
 * CSRF defence for cookie-authenticated, state-changing requests, on top of
 * SameSite=Lax: the browser's Origin header must match our host, and a body
 * must be JSON (an HTML form can't send `application/json`, and a cross-site
 * fetch that does needs a CORS preflight, which we never grant).
 */
function assertSameOrigin(req: Request): void {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
  const origin = req.headers.origin;
  if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, "cross-origin request refused");
  const contentType = req.headers["content-type"];
  if (contentType && !/^application\/json\b/i.test(contentType)) throw new HttpError(415, "expected application/json");
}

/** REST API authentication: session cookie (dashboard) or API key (scripts). */
export function requireUser(db: Db) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const key = bearerToken(req);
    if (key) {
      req.principal = await principalFromApiKey(db, key);
    } else {
      const token = readCookie(req, SESSION_COOKIE);
      req.principal = token ? await principalFromSession(db, token) : undefined;
      if (req.principal) assertSameOrigin(req);
    }
    if (!req.principal) throw new HttpError(401, "not authenticated");
    next();
  };
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (req.principal?.role !== "admin") throw new HttpError(403, "admin only");
  next();
}
