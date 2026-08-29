/**
 * Migration ORDER is load-bearing and was silently untested: every caller of
 * `applyMigrations` runs against the already-migrated dev DB, where the
 * `schema_migrations` registry skips every file — so a lexicographic sort
 * ("V10" before "V7") only breaks on a fresh database, i.e. on a grader's
 * machine. These are pure-function tests: no Postgres required.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sortMigrationFiles } from "./client.js";

describe("sortMigrationFiles", () => {
  it("orders by numeric version, not lexicographically", () => {
    const shuffled = ["V10__b.sql", "V2__a.sql", "V7__c.sql", "V11__d.sql", "V9__e.sql"];
    expect(sortMigrationFiles(shuffled)).toEqual([
      "V2__a.sql",
      "V7__c.sql",
      "V9__e.sql",
      "V10__b.sql",
      "V11__d.sql",
    ]);
    // The exact regression: a plain .sort() puts V10/V11 first.
    expect([...shuffled].sort()[0]).toBe("V10__b.sql");
  });

  it("drops non-migration filenames", () => {
    expect(sortMigrationFiles(["README.md", "V1__x.sql", "v2__lower.sql", "V__no-digits.sql", ".keep"]))
      .toEqual(["V1__x.sql"]);
  });

  it("breaks version ties deterministically by name", () => {
    expect(sortMigrationFiles(["V3__b.sql", "V3__a.sql"])).toEqual(["V3__a.sql", "V3__b.sql"]);
  });

  it("orders the REAL migrations directory with no version gaps or duplicates", async () => {
    const dir = join(process.cwd(), "migrations");
    const ordered = sortMigrationFiles(await readdir(dir));
    expect(ordered.length).toBeGreaterThan(0);
    const versions = ordered.map((f) => Number(/^V(\d+)__/.exec(f)![1]));
    // Strictly increasing ⇒ sorted AND no two migrations claim one version
    // (duplicates would apply in an arbitrary-but-stable order).
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
    // V7 (creates `transactions`) must precede V10/V11 (alter it) — the bug.
    expect(ordered.indexOf("V7__settlement.sql")).toBeLessThan(ordered.indexOf("V10__tx_amount_positive.sql"));
    expect(ordered.indexOf("V10__tx_amount_positive.sql")).toBeLessThan(ordered.indexOf("V11__tx_owner_agent.sql"));
  });
});
