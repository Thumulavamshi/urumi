// Dashboard login, logout, "who am I", and accepting an invite.
import { Router } from "express";
import { z } from "zod";
import { createSession, destroySession, HttpError, requireUser } from "../auth.ts";
import { hashPassword, sha256, verifyPassword } from "../crypto.ts";
import { tx } from "../db.ts";
import { log } from "../log.ts";
import { parse, type Deps } from "./util.ts";

const Login = z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1).max(200) });
const Accept = z.object({ name: z.string().trim().min(1).max(100).optional(), password: z.string().min(10).max(200) });

export function authRoutes({ db, cfg }: Deps): Router {
  const r = Router();
  const sessionOpts = { ttlHours: cfg.sessionTtlHours, secure: cfg.cookieSecure };

  r.post("/auth/login", async (req, res) => {
    const { email, password } = parse(Login, req.body);
    const { rows } = await db.query<{ id: number; password_hash: string | null; disabled_at: Date | null }>(
      "SELECT id, password_hash, disabled_at FROM users WHERE email = $1",
      [email],
    );
    const user = rows[0];
    // Same message (and roughly the same time, see verifyPassword) whether the
    // email exists or not.
    const ok = await verifyPassword(password, user?.password_hash ?? null);
    if (!user || !ok || user.disabled_at) {
      log({ msg: "login failed", email });
      throw new HttpError(401, "invalid email or password");
    }
    await createSession(db, res, user.id, sessionOpts);
    log({ msg: "login", email });
    res.json({ ok: true });
  });

  r.post("/auth/logout", async (req, res) => {
    await destroySession(db, req, res);
    res.json({ ok: true });
  });

  r.get("/auth/me", requireUser(db), (req, res) => {
    const { id, email, name, role } = req.principal!;
    res.json({ id, email, name, role });
  });

  // Invite links: GET shows who it's for, POST sets the password and logs in.
  r.get("/invites/:token", async (req, res) => {
    const { rows } = await db.query<{ email: string; name: string }>(
      `SELECT u.email, u.name FROM invites i JOIN users u ON u.id = i.user_id
        WHERE i.token_hash = $1 AND i.used_at IS NULL AND i.expires_at > now() AND u.disabled_at IS NULL`,
      [sha256(req.params.token)],
    );
    if (!rows[0]) throw new HttpError(404, "invite not found, used or expired");
    res.json(rows[0]);
  });

  r.post("/invites/:token/accept", async (req, res) => {
    const body = parse(Accept, req.body);
    const passwordHash = await hashPassword(body.password);
    const userId = await tx(db, async (c) => {
      // FOR UPDATE + used_at check: an invite link works exactly once.
      const { rows } = await c.query<{ id: number; user_id: number }>(
        `SELECT i.id, i.user_id FROM invites i JOIN users u ON u.id = i.user_id
          WHERE i.token_hash = $1 AND i.used_at IS NULL AND i.expires_at > now() AND u.disabled_at IS NULL
          FOR UPDATE OF i`,
        [sha256(req.params.token)],
      );
      const invite = rows[0];
      if (!invite) throw new HttpError(404, "invite not found, used or expired");
      await c.query("UPDATE invites SET used_at = now() WHERE id = $1", [invite.id]);
      await c.query("UPDATE users SET password_hash = $1, name = COALESCE($2, name) WHERE id = $3", [
        passwordHash,
        body.name ?? null,
        invite.user_id,
      ]);
      // Accepting an invite (also used for password resets) logs out other sessions.
      await c.query("DELETE FROM sessions WHERE user_id = $1", [invite.user_id]);
      return invite.user_id;
    });
    await createSession(db, res, userId, sessionOpts);
    res.json({ ok: true });
  });

  return r;
}
