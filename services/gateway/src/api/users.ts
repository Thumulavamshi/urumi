// Team management (admin only): invite, list, change role, disable, re-issue invite.
import { Router } from "express";
import { z } from "zod";
import { HttpError, requireAdmin } from "../auth.ts";
import { randomToken, sha256 } from "../crypto.ts";
import { tx, type Queryable } from "../db.ts";
import { log } from "../log.ts";
import { KEY_COLUMNS } from "./keys.ts";
import { idParam, parse, type Deps } from "./util.ts";

const Invite = z.object({
  email: z.string().trim().toLowerCase().email(),
  name: z.string().trim().min(1).max(100),
  role: z.enum(["admin", "member"]).default("member"),
});
const Update = z.object({
  role: z.enum(["admin", "member"]).optional(),
  disabled: z.boolean().optional(),
});

export function userRoutes({ db, cfg, mcp }: Deps): Router {
  const r = Router();
  r.use("/users", requireAdmin);

  async function issueInvite(c: Queryable, userId: number, by: number): Promise<{ inviteUrl: string; expiresAt: Date }> {
    const token = randomToken(32);
    await c.query("UPDATE invites SET used_at = now() WHERE user_id = $1 AND used_at IS NULL", [userId]); // old links die
    const { rows } = await c.query<{ expires_at: Date }>(
      `INSERT INTO invites (user_id, token_hash, created_by, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(hours => $4)) RETURNING expires_at`,
      [userId, sha256(token), by, cfg.inviteTtlHours],
    );
    // The link is returned once, to the admin, who passes it on.
    return { inviteUrl: `${cfg.publicUrl}/invite/${token}`, expiresAt: rows[0]!.expires_at };
  }

  r.get("/users", async (_req, res) => {
    const { rows: users } = await db.query(
      `SELECT u.id, u.email, u.name, u.role, u.created_at AS "createdAt", u.disabled_at AS "disabledAt",
              (u.password_hash IS NULL) AS "invitePending"
         FROM users u ORDER BY u.id`,
    );
    const { rows: keys } = await db.query(`SELECT user_id AS "userId", ${KEY_COLUMNS} FROM api_keys ORDER BY id DESC`);
    res.json(users.map((u) => ({ ...u, keys: keys.filter((k) => k.userId === u.id) })));
  });

  r.post("/users", async (req, res) => {
    const body = parse(Invite, req.body);
    const result = await tx(db, async (c) => {
      const { rows } = await c
        .query<{ id: number }>("INSERT INTO users (email, name, role) VALUES ($1, $2, $3) RETURNING id", [
          body.email,
          body.name,
          body.role,
        ])
        .catch((err) => {
          if (err.code === "23505") throw new HttpError(409, "a user with that email already exists");
          throw err;
        });
      const id = rows[0]!.id;
      return { id, ...(await issueInvite(c, id, req.principal!.id)) };
    });
    log({ msg: "user invited", email: body.email, role: body.role, by: req.principal!.email });
    res.status(201).json(result);
  });

  // New invite link for someone who lost theirs (or as a password reset).
  r.post("/users/:id/invite", async (req, res) => {
    const id = idParam(req.params.id);
    const result = await tx(db, async (c) => {
      const { rowCount } = await c.query("SELECT 1 FROM users WHERE id = $1", [id]);
      if (!rowCount) throw new HttpError(404, "user not found");
      return issueInvite(c, id, req.principal!.id);
    });
    res.json(result);
  });

  r.patch("/users/:id", async (req, res) => {
    const id = idParam(req.params.id);
    const patch = parse(Update, req.body);
    if (id === req.principal!.id) throw new HttpError(400, "you can't change your own role or disable yourself");

    await tx(db, async (c) => {
      const { rows } = await c.query<{ role: string }>("SELECT role FROM users WHERE id = $1 FOR UPDATE", [id]);
      if (!rows[0]) throw new HttpError(404, "user not found");
      if (patch.role) await c.query("UPDATE users SET role = $2 WHERE id = $1", [id, patch.role]);
      if (patch.disabled !== undefined) {
        await c.query("UPDATE users SET disabled_at = CASE WHEN $2 THEN now() ELSE NULL END WHERE id = $1", [
          id,
          patch.disabled,
        ]);
        if (patch.disabled) await c.query("DELETE FROM sessions WHERE user_id = $1", [id]);
      }
    });
    // A disabled user's keys stop working at once (auth joins on disabled_at); drop live MCP sessions too.
    if (patch.disabled) mcp.closeSessions((p) => p.id === id);
    log({ msg: "user updated", userId: id, ...patch, by: req.principal!.email });
    res.json({ ok: true });
  });

  return r;
}
