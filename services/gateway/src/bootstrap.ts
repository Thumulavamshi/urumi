// Startup seeding from Helm values / Secrets, so a fresh install is usable:
//  - the first admin (only created if that email doesn't exist yet; never overwritten)
//  - "managed" upstream servers, e.g. the WooCommerce MCP server. These are
//    converged on every start (URL/auth/credential follow the values), but an
//    admin's enable/disable choice is kept.
import type { Config } from "./config.ts";
import type { CredentialBox } from "./crypto.ts";
import { hashPassword } from "./crypto.ts";
import type { Db } from "./db.ts";
import { log } from "./log.ts";
import type { ServerRow } from "./upstreams.ts";

export async function bootstrap(db: Db, cfg: Config, box: CredentialBox): Promise<void> {
  const admin = cfg.bootstrapAdmin;
  if (admin) {
    const { rowCount } = await db.query(
      `INSERT INTO users (email, name, role, password_hash) VALUES ($1, $2, 'admin', $3)
       ON CONFLICT (email) DO NOTHING`,
      [admin.email, admin.name, await hashPassword(admin.password)],
    );
    if (rowCount) log({ msg: "bootstrap admin created", email: admin.email });
  }

  for (const s of cfg.bootstrapServers) {
    const credential = s.credentialEnv ? process.env[s.credentialEnv] : undefined;
    if (s.credentialEnv && !credential) throw new Error(`bootstrap server ${s.slug}: env ${s.credentialEnv} is empty`);
    const headerName = s.authType === "header" ? (s.authHeaderName ?? null) : null;

    const { rows } = await db.query<ServerRow>("SELECT * FROM servers WHERE slug = $1", [s.slug]);
    const existing = rows[0];
    if (!existing) {
      await db.query(
        `INSERT INTO servers (slug, name, url, auth_type, auth_header_name, credential_enc, enabled, managed)
         VALUES ($1, $2, $3, $4, $5, $6, true, true)`,
        [s.slug, s.name, s.url, s.authType, headerName, credential ? box.encrypt(credential, s.slug) : null],
      );
      log({ msg: "bootstrap server registered", slug: s.slug, url: s.url });
      continue;
    }
    if (!existing.managed) {
      log({ msg: "bootstrap server skipped: slug taken by an admin-created server", slug: s.slug });
      continue;
    }
    const currentCredential = existing.credential_enc ? box.decrypt(existing.credential_enc, s.slug) : undefined;
    const changed =
      existing.name !== s.name ||
      existing.url !== s.url ||
      existing.auth_type !== s.authType ||
      existing.auth_header_name !== headerName ||
      currentCredential !== credential;
    if (changed) {
      await db.query(
        `UPDATE servers SET name = $2, url = $3, auth_type = $4, auth_header_name = $5, credential_enc = $6, updated_at = now()
          WHERE id = $1`,
        [existing.id, s.name, s.url, s.authType, headerName, credential ? box.encrypt(credential, s.slug) : null],
      );
      log({ msg: "bootstrap server updated", slug: s.slug });
    }
  }
}
