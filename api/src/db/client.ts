/**
 * Postgres seam — the FIRST db-touching module of the repo (M1–M5 were pure).
 * Deliberately thin: a pool factory plus a file-ordered migration applier.
 * Migrations live in api/migrations/*.sql, applied each inside ONE
 * transaction, tracked in schema_migrations — enough for demo + tests; a
 * heavier runner would be ceremony at this scale.
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

/**
 * Turn a "Postgres isn't there" failure into an instruction (audit 14.1).
 *
 * The DB-backed suites are the ones that cover settlement, the audit chain and
 * the pipeline; a bare `ECONNREFUSED 127.0.0.1:15432` in a `beforeAll` reads as
 * "some infra flake" and invites re-running until it's ignored, while the
 * pure-`shared` suites stay green and make CI look fine. Naming the fix in the
 * message is the difference between a skipped signal and a fixed environment.
 */
function withConnectionHint(e: unknown): Error {
  const err = e instanceof Error ? e : new Error(String(e));
  const code = (e as { code?: string } | null)?.code;
  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "ETIMEDOUT") {
    return new Error(
      `cannot reach Postgres (${err.message}). The DB-backed suites and the demo BOTH need it: ` +
        `start it with \`npm run db:up\` (docker compose, host port 15432), or point DATABASE_URL ` +
        `at your own instance. A green run without it only proves the pure-shared tests passed.`,
      { cause: err },
    );
  }
  return err;
}

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

/**
 * Where the migrations live, resolved from THIS MODULE rather than the process
 * working directory (audit 10.5 / 18.2). `join(process.cwd(), "migrations")`
 * meant `npx tsx api/src/server.ts` from the repo root died on
 * `ENOENT … scandir '<repo>/migrations'` — the server booted only when launched
 * from inside `api/`. Both layouts land on `api/migrations`:
 *   src/db/client.ts  → ../../migrations
 *   dist/db/client.js → ../../migrations
 * MIGRATIONS_DIR overrides it for anything exotic.
 */
export function defaultMigrationsDir(): string {
  const fromEnv = process.env.MIGRATIONS_DIR;
  if (fromEnv !== undefined && fromEnv.trim() !== "") return resolve(fromEnv);
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");
}

/** Apply every not-yet-applied V*.sql in VERSION order, one transaction each. */
export async function applyMigrations(
  db: PgPool,
  dir = defaultMigrationsDir(),
): Promise<string[]> {
  try {
    await ensureRegistry(db);
  } catch (e) {
    throw withConnectionHint(e);
  }
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
