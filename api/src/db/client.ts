/**
 * Postgres seam — the FIRST db-touching module of the repo (M1–M5 were pure).
 * Deliberately thin: a pool factory plus a file-ordered migration applier.
 * Migrations live in api/migrations/*.sql, applied each inside ONE
 * transaction, tracked in schema_migrations — enough for demo + tests; a
 * heavier runner would be ceremony at this scale.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";

export type PgPool = pg.Pool;
export type PgClient = pg.PoolClient;
export type QueryResultRow = pg.QueryResultRow;

/** docker-compose maps PG to 15432 (dodges local services); .env.example pins
 *  the same default so zero-config boots agree. */
export const DEFAULT_DATABASE_URL =
  "postgres://growthagent_owner:growthagent_owner@localhost:15432/growthagent";

export function createPool(databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL): PgPool {
  return new pg.Pool({ connectionString: databaseUrl, max: 10 });
}

const MIGRATION_NAME_RE = /^V\d+__.+\.sql$/;

async function ensureRegistry(db: PgPool | PgClient): Promise<void> {
  await db.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name       TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
}

/** Apply every not-yet-applied V*.sql in filename order, one transaction each. */
export async function applyMigrations(
  db: PgPool,
  dir = join(process.cwd(), "migrations"),
): Promise<string[]> {
  await ensureRegistry(db);
  const files = (await readdir(dir)).filter((f) => MIGRATION_NAME_RE.test(f)).sort();
  const applied: string[] = [];
  for (const file of files) {
    const seen = await db.query("SELECT 1 FROM schema_migrations WHERE name = $1", [file]);
    if (seen.rowCount && seen.rowCount > 0) continue;
    const sql = await readFile(join(dir, file), "utf8");
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
      applied.push(file);
    } catch (e) {
      await client.query("ROLLBACK");
      throw new Error(`migration ${file} failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      client.release();
    }
  }
  return applied;
}
