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

/** Numeric version embedded in a "V<n>__*.sql" name (the regex guarantees it). */
function migrationVersion(file: string): number {
  return Number(/^V(\d+)__/.exec(file)![1]);
}

/**
 * Filter to migration filenames and order them by VERSION, not lexicographically
 * — a plain string sort places "V10__" before "V7__" (‘1’ < ‘7’) and, on a fresh
 * DB, runs V10 before the migrations it depends on. Exported so the ordering
 * itself is testable without a live database (every caller of `applyMigrations`
 * runs against an already-migrated dev DB, where the registry short-circuits
 * every file and ordering bugs stay invisible).
 */
export function sortMigrationFiles(files: readonly string[]): string[] {
  return files
    .filter((f) => MIGRATION_NAME_RE.test(f))
    .sort((a, b) => migrationVersion(a) - migrationVersion(b) || a.localeCompare(b));
}

/** Apply every not-yet-applied V*.sql in VERSION order, one transaction each. */
export async function applyMigrations(
  db: PgPool,
  dir = join(process.cwd(), "migrations"),
): Promise<string[]> {
  await ensureRegistry(db);
  const files = sortMigrationFiles(await readdir(dir));
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
