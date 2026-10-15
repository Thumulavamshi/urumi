// Personal API keys. Anyone can manage their own; admins can revoke anyone's.
import { Router } from "express";
import { z } from "zod";
import { HttpError } from "../auth.ts";
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

  r.post("/me/keys", async (req, res) => {
    const { name } = parse(NewKey, req.body);
    const { key, prefix, hash } = newApiKey();
    const { rows } = await db.query(
      `INSERT INTO api_keys (user_id, name, prefix, key_hash) VALUES ($1, $2, $3, $4) RETURNING ${KEY_COLUMNS}`,
      [req.principal!.id, name, prefix, hash],
    );
    log({ msg: "api key created", user: req.principal!.email, prefix });
    // The only time the full key is ever returned. We keep just its hash.
    res.status(201).json({
      ...rows[0],
      key,
      mcpUrl: `${cfg.publicUrl}/mcp`,
      claudeCode: `claude mcp add --transport http urumi-gateway ${cfg.publicUrl}/mcp --header "Authorization: Bearer ${key}"`,
    });
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
