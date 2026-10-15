// Audit log. Admins see everyone's calls; members see only their own.
// Keyset pagination (`before=<id>`) so pages stay stable while new rows arrive.
import { Router } from "express";
import { z } from "zod";
import { parse, type Deps } from "./util.ts";

const Query = z.object({
  userId: z.coerce.number().int().positive().optional(),
  server: z.string().max(30).optional(),
  tool: z.string().max(160).optional(),
  outcome: z.enum(["success", "error", "timeout", "denied", "unreachable"]).optional(),
  via: z.enum(["mcp", "chat"]).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export function auditRoutes({ db }: Deps): Router {
  const r = Router();

  r.get("/audit", async (req, res) => {
    const q = parse(Query, req.query);
    const me = req.principal!;
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replace("?", `$${params.length}`));
    };

    if (me.role !== "admin") add("user_id = ?", me.id);
    else if (q.userId) add("user_id = ?", q.userId);
    if (q.server) add("server_slug = ?", q.server);
    if (q.tool) add("tool ILIKE ?", `%${q.tool}%`);
    if (q.outcome) add("outcome = ?", q.outcome);
    if (q.via) add("via = ?", q.via);
    if (q.from) add("at >= ?", q.from);
    if (q.to) add("at < ?", q.to);
    if (q.before) add("id < ?", q.before);
    params.push(q.limit + 1);

    const { rows } = await db.query(
      `SELECT id, at, user_id AS "userId", user_email AS "userEmail", server_slug AS "server", tool, via,
              duration_ms AS "durationMs", outcome, error
         FROM audit_log ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY id DESC LIMIT $${params.length}`,
      params,
    );
    const hasMore = rows.length > q.limit;
    const items = rows.slice(0, q.limit);
    res.json({ items, nextBefore: hasMore ? items.at(-1)!.id : null });
  });

  return r;
}
