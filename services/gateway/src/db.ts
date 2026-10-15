// Postgres access: a pool, a transaction helper, and a tiny migration runner.
// Plain SQL with parameters ($1, $2…) everywhere — no ORM, nothing hidden.
import { readdir, readFile } from "node:fs/promises";
import pg from "pg";
import { log } from "./log.ts";

// bigint ids come back as strings by default; ours fit comfortably in a JS number.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export type Db = pg.Pool;
export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(databaseUrl: string): Db {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10, connectionTimeoutMillis: 5_000 });
  // An idle client losing its connection (e.g. Postgres restart) must not crash the process.
  pool.on("error", (err) => log({ msg: "postgres idle client error", error: err.message }));
  return pool;
}

export async function tx<T>(db: Db, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const MIGRATION_LOCK = 72_616_001; // arbitrary constant shared by all replicas

/** Applies pending `migrations/*.sql` files in order. Safe with several replicas. */
export async function migrate(db: Db): Promise<void> {
  const dir = new URL("./migrations/", import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();

  const client = await db.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const { rows } = await client.query<{ name: string }>("SELECT name FROM schema_migrations");
    const applied = new Set(rows.map((r) => r.name));

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(new URL(file, dir), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        log({ msg: "migration applied", file });
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK]).catch(() => {});
    client.release();
  }
}

/** Waits for Postgres at startup (it may still be starting when the gateway pod does). */
export async function waitForDb(db: Db, attempts = 30): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      await db.query("SELECT 1");
      return;
    } catch (err) {
      if (i >= attempts) throw err;
      log({ msg: "waiting for postgres", attempt: i, error: (err as Error).message });
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
}
