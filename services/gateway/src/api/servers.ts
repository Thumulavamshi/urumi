// Upstream server registry. Everyone can see servers, status and tools;
// only admins can change them. Credentials are write-only: the API accepts
// them, encrypts them, and only ever reports `hasCredential: true|false`.
import { Router } from "express";
import { z } from "zod";
import { HttpError, requireAdmin } from "../auth.ts";
import { log } from "../log.ts";
import { SsrfError } from "../ssrf.ts";
import type { ServerRow, ServerView } from "../upstreams.ts";
import { idParam, parse, type Deps } from "./util.ts";

// Headers an upstream credential may not be sent as (they'd break or hijack the transport).
const RESERVED_HEADERS = new Set([
  "host", "content-length", "content-type", "accept", "connection", "transfer-encoding",
  "mcp-session-id", "mcp-protocol-version", "last-event-id", "cookie",
]);

const url = z
  .string()
  .trim()
  .url()
  .refine((u) => ["http:", "https:"].includes(new URL(u).protocol), "must be an http(s) URL");
const headerName = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9-]{1,64}$/, "invalid header name")
  .refine((h) => !RESERVED_HEADERS.has(h.toLowerCase()), "reserved header");
const authType = z.enum(["none", "bearer", "header"]);
const credential = z.string().min(1).max(4096);

const Create = z
  .object({
    slug: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9-]{0,29}$/, "lowercase letters, digits and '-', starting with a letter, max 30"),
    name: z.string().trim().min(1).max(80),
    url,
    authType: authType.default("none"),
    authHeaderName: headerName.optional(),
    credential: credential.optional(),
    enabled: z.boolean().default(true),
  })
  .refine((s) => s.authType !== "header" || s.authHeaderName, { message: "authHeaderName required", path: ["authHeaderName"] })
  .refine((s) => s.authType === "none" || s.credential, { message: "credential required", path: ["credential"] });

const Update = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  url: url.optional(),
  authType: authType.optional(),
  authHeaderName: headerName.nullable().optional(),
  credential: credential.nullable().optional(), // omitted = keep, null = clear, string = replace
  enabled: z.boolean().optional(),
});

const Test = z.object({
  slug: z.string().default("test"),
  url,
  authType: authType.default("none"),
  authHeaderName: headerName.optional(),
  credential: credential.optional(),
  /** Test edited settings of an existing server, reusing its stored credential if none is given. */
  serverId: z.number().int().positive().optional(),
});

export function serverRoutes({ db, box, upstreams, guard, policy }: Deps): Router {
  const r = Router();

  // Refuse internal/metadata URLs up front with a clear 400. The same check runs
  // again on every connection (DNS can change), see src/ssrf.ts.
  async function checkUrl(url: string): Promise<void> {
    try {
      await guard.check(url);
    } catch (err) {
      if (err instanceof SsrfError) throw new HttpError(400, err.message);
      throw err;
    }
  }

  async function load(id: number): Promise<ServerRow> {
    const { rows } = await db.query<ServerRow>("SELECT * FROM servers WHERE id = $1", [id]);
    if (!rows[0]) throw new HttpError(404, "server not found");
    return rows[0];
  }

  // Tools are marked adminOnly per the role policy (src/policy.ts).
  const withPolicy = (v: ServerView | undefined) =>
    v && { ...v, tools: v.tools.map((t) => ({ ...t, adminOnly: policy.adminOnly(t.exposedAs) })) };

  r.get("/servers", (_req, res) => {
    res.json(upstreams.views().map(withPolicy));
  });

  // The aggregated tool list exactly as this user's MCP clients see it.
  r.get("/tools", (req, res) => {
    res.json(policy.filter(req.principal!, upstreams.aggregatedTools()));
  });

  r.post("/servers", requireAdmin, async (req, res) => {
    const s = parse(Create, req.body);
    await checkUrl(s.url);
    const enc = s.authType !== "none" && s.credential ? box.encrypt(s.credential, s.slug) : null;
    const { rows } = await db
      .query<{ id: number }>(
        `INSERT INTO servers (slug, name, url, auth_type, auth_header_name, credential_enc, enabled)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [s.slug, s.name, s.url, s.authType, s.authType === "header" ? s.authHeaderName : null, enc, s.enabled],
      )
      .catch((err) => {
        if (err.code === "23505") throw new HttpError(409, `slug '${s.slug}' already exists`);
        throw err;
      });
    const id = rows[0]!.id;
    log({ msg: "server created", slug: s.slug, by: req.principal!.email });
    await upstreams.refresh(id); // connects + lists tools before we answer
    res.status(201).json(withPolicy(upstreams.view(id)));
  });

  r.patch("/servers/:id", requireAdmin, async (req, res) => {
    const id = idParam(req.params.id);
    const patch = parse(Update, req.body);
    const row = await load(id);

    const touchesConnection =
      patch.url !== undefined || patch.authType !== undefined || patch.authHeaderName !== undefined || patch.credential !== undefined;
    if (row.managed && touchesConnection) {
      throw new HttpError(400, "this server is managed by Helm values; change its URL/credential there");
    }
    if (patch.url !== undefined) await checkUrl(patch.url);

    const next = {
      name: patch.name ?? row.name,
      url: patch.url ?? row.url,
      authType: patch.authType ?? row.auth_type,
      authHeaderName: patch.authHeaderName === undefined ? row.auth_header_name : patch.authHeaderName,
      credentialEnc:
        patch.credential === undefined
          ? row.credential_enc
          : patch.credential === null
            ? null
            : box.encrypt(patch.credential, row.slug),
      enabled: patch.enabled ?? row.enabled,
    };
    if (next.authType === "none") next.credentialEnc = null;
    if (next.authType !== "header") next.authHeaderName = null;
    if (next.authType === "header" && !next.authHeaderName) throw new HttpError(400, "authHeaderName required");
    if (next.authType !== "none" && !next.credentialEnc) throw new HttpError(400, "credential required");

    await db.query(
      `UPDATE servers SET name = $2, url = $3, auth_type = $4, auth_header_name = $5, credential_enc = $6,
              enabled = $7, updated_at = now()
        WHERE id = $1`,
      [id, next.name, next.url, next.authType, next.authHeaderName, next.credentialEnc, next.enabled],
    );
    log({ msg: "server updated", slug: row.slug, fields: Object.keys(patch), by: req.principal!.email });
    await upstreams.refresh(id);
    res.json(withPolicy(upstreams.view(id)));
  });

  r.delete("/servers/:id", requireAdmin, async (req, res) => {
    const row = await load(idParam(req.params.id));
    if (row.managed) throw new HttpError(400, "this server is managed by Helm values; disable it instead");
    await db.query("DELETE FROM servers WHERE id = $1", [row.id]);
    log({ msg: "server deleted", slug: row.slug, by: req.principal!.email });
    await upstreams.refresh();
    res.json({ ok: true });
  });

  // Test settings without saving them (dashboard form), or a saved server as-is.
  r.post("/servers/test", requireAdmin, async (req, res) => {
    const t = parse(Test, req.body);
    await checkUrl(t.url);
    let cred = t.credential ?? null;
    if (!cred && t.serverId && t.authType !== "none") {
      const row = await load(t.serverId);
      cred = row.credential_enc ? box.decrypt(row.credential_enc, row.slug) : null;
    }
    res.json(await upstreams.test({ slug: t.slug, url: t.url, authType: t.authType, authHeaderName: t.authHeaderName, credential: cred }));
  });

  r.post("/servers/:id/test", requireAdmin, async (req, res) => {
    const row = await load(idParam(req.params.id));
    res.json(
      await upstreams.test({
        slug: row.slug,
        url: row.url,
        authType: row.auth_type,
        authHeaderName: row.auth_header_name,
        credential: row.credential_enc ? box.decrypt(row.credential_enc, row.slug) : null,
      }),
    );
  });

  return r;
}
