// Personal API keys. Anyone can manage their own; admins can also issue keys
// for members and revoke anyone's.
import { Router } from "express";
import { z } from "zod";
import { HttpError, requireAdmin } from "../auth.ts";
import { newApiKey } from "../crypto.ts";
import { log } from "../log.ts";
import { idParam, parse, type Deps } from "./util.ts";

const NewKey = z.object({ name: z.string().trim().min(1).max(60) });

export const KEY_COLUMNS = `id, name, prefix, created_at AS "createdAt", last_used_at AS "lastUsedAt", revoked_at AS "revokedAt"`;

export function keyRoutes({ db, mcp, cfg }: Deps): Router {
  const r = Router();

  r.get("/me/keys", async (req, res) => {
    const { rows } = await db.query(`SELECT ${KEY_COLUMNS} FROM api_keys WHERE user_id = $1 ORDER BY id DESC`, [
      req.principal!.id,
    ]);
    res.json(rows);
  });

  async function createKey(userId: number, name: string, by: string) {
    const { key, prefix, hash } = newApiKey();
    const { rows } = await db.query(
      `INSERT INTO api_keys (user_id, name, prefix, key_hash) VALUES ($1, $2, $3, $4) RETURNING ${KEY_COLUMNS}`,
      [userId, name, prefix, hash],
    );
    log({ msg: "api key created", userId, by, prefix });
    // The only time the full key is ever returned. We keep just its hash.
    return {
      ...rows[0],
      key,
      mcpUrl: `${cfg.publicUrl}/mcp`,
      claudeCode: `claude mcp add --transport http urumi-gateway ${cfg.publicUrl}/mcp --header "Authorization: Bearer ${key}"`,
    };
  }

  r.post("/me/keys", async (req, res) => {
    const { name } = parse(NewKey, req.body);
    res.status(201).json(await createKey(req.principal!.id, name, req.principal!.email));
  });

  // Admin issues a key on a member's behalf (shown once, to the admin, who hands it over).
  // The key acts as that member: their role, their audit trail.
  r.post("/users/:id/keys", requireAdmin, async (req, res) => {
    const id = idParam(req.params.id);
    const { name } = parse(NewKey, req.body);
    const { rows } = await db.query<{ disabled_at: Date | null }>("SELECT disabled_at FROM users WHERE id = $1", [id]);
    if (!rows[0]) throw new HttpError(404, "user not found");
    if (rows[0].disabled_at) throw new HttpError(400, "user is disabled");
    res.status(201).json(await createKey(id, name, req.principal!.email));
  });

  // Owner or admin. Revocation is immediate: every MCP request re-checks the key,
  // and we also cut this replica's live sessions for it right now.
  r.delete("/keys/:id", async (req, res) => {
    const id = idParam(req.params.id);
    const me = req.principal!;
    const { rows } = await db.query<{ id: number; user_id: number }>(
      `UPDATE api_keys SET revoked_at = now(), revoked_by = $2
        WHERE id = $1 AND revoked_at IS NULL AND (user_id = $3 OR $4)
        RETURNING id, user_id`,
      [id, me.id, me.id, me.role === "admin"],
    );
    if (!rows[0]) throw new HttpError(404, "key not found or already revoked");
    const sessions = mcp.closeSessions((p) => p.apiKeyId === id);
    log({ msg: "api key revoked", keyId: id, by: me.email, sessionsClosed: sessions });
    res.json({ ok: true, sessionsClosed: sessions });
  });

  return r;
}
