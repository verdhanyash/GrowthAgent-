/**
 * store.spec.ts — audit H4: the ACTIVE merchant rules used to live in a
 * `let currentRules` closure in the composition root, so a PUT /v1/admin/rules
 * on replica A never reached replicas B–D. Identical carts were then judged
 * under different caps depending on which instance answered — no error, no
 * alert, no audit row for the discrepancy.
 *
 * These tests drive TWO stores against ONE database, which is the shape of the
 * bug, and pin the TTL semantics the read-through relies on.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MEERA_RULES_V3, type MerchantRulesConfig } from "@growthagent/shared";
import { applyMigrations, createPool, type PgPool } from "../../db/client.js";
import { RulesStore } from "../store.js";

let db: PgPool;

beforeAll(async () => {
  db = createPool();
  await applyMigrations(db);
});

afterAll(async () => {
  await db.end();
});

beforeEach(async () => {
  await db.query(`TRUNCATE merchant_rules`);
});

/** Persist a new version the way the admin PUT route does. */
async function publish(patch: Partial<MerchantRulesConfig>, version: number): Promise<MerchantRulesConfig> {
  const next: MerchantRulesConfig = { ...MEERA_RULES_V3, ...patch, rules_version: version };
  await db.query(
    `INSERT INTO merchant_rules (rules_version, rules_json, actor, note, increase)
     VALUES ($1, $2, 'test', 'test', false)`,
    [version, JSON.stringify(next)],
  );
  return next;
}

describe("RulesStore.boot", () => {
  it("seeds the fixture when the table is empty", async () => {
    const store = new RulesStore(db);
    const booted = await store.boot();
    expect(booted.rules_version).toBe(MEERA_RULES_V3.rules_version);
    const r = await db.query(`SELECT count(*)::int AS n FROM merchant_rules`);
    expect((r.rows[0] as { n: number }).n).toBe(1);
  });

  it("adopts the HIGHEST existing version instead of re-seeding", async () => {
    await publish({ max_discount_pct: 12 }, 9);
    const store = new RulesStore(db);
    const booted = await store.boot();
    expect(booted.rules_version).toBe(9);
    expect(booted.max_discount_pct).toBe(12);
  });

  it("two replicas booting concurrently do not collide on the seed", async () => {
    const [a, b] = await Promise.all([new RulesStore(db).boot(), new RulesStore(db).boot()]);
    expect(a.rules_version).toBe(MEERA_RULES_V3.rules_version);
    expect(b.rules_version).toBe(MEERA_RULES_V3.rules_version);
  });
});

describe("RulesStore.load — cross-replica read-through (audit H4)", () => {
  it("replica B sees a version replica A published", async () => {
    const a = new RulesStore(db, { ttlMs: 0 });
    const b = new RulesStore(db, { ttlMs: 0 });
    await a.boot();
    await b.boot();
    expect((await b.load()).max_discount_pct).toBe(MEERA_RULES_V3.max_discount_pct);

    // A publishes and refreshes its own snapshot (the local fast path).
    const next = await publish({ max_discount_pct: 12 }, MEERA_RULES_V3.rules_version + 1);
    a.set(next);

    // B never heard about it — and must still judge under the NEW cap.
    const seenByB = await b.load();
    expect(seenByB.rules_version).toBe(next.rules_version);
    expect(seenByB.max_discount_pct).toBe(12);
  });

  it("caches within the TTL and re-reads after it", async () => {
    let now = 1_000_000;
    const store = new RulesStore(db, { ttlMs: 1_000, nowMs: () => now });
    await store.boot();

    await publish({ max_discount_pct: 12 }, MEERA_RULES_V3.rules_version + 1);
    expect((await store.load()).max_discount_pct).toBe(MEERA_RULES_V3.max_discount_pct); // cached
    now += 999;
    expect((await store.load()).max_discount_pct).toBe(MEERA_RULES_V3.max_discount_pct); // still cached
    now += 2;
    expect((await store.load()).max_discount_pct).toBe(12); // TTL elapsed
  });

  it("refresh() bypasses the TTL", async () => {
    const store = new RulesStore(db, { ttlMs: 3_600_000 });
    await store.boot();
    await publish({ max_cart_value_paise: 600_000 }, MEERA_RULES_V3.rules_version + 1);
    expect((await store.load()).max_cart_value_paise).toBe(MEERA_RULES_V3.max_cart_value_paise);
    expect((await store.refresh()).max_cart_value_paise).toBe(600_000);
  });

  it("coalesces a burst of concurrent loads", async () => {
    const store = new RulesStore(db, { ttlMs: 0 });
    await store.boot();
    await publish({ max_discount_pct: 11 }, MEERA_RULES_V3.rules_version + 1);
    const all = await Promise.all(Array.from({ length: 8 }, () => store.load()));
    expect(all.every((r) => r.max_discount_pct === 11)).toBe(true);
  });

  it("version()/snapshot() report the last LOADED value, not a stale seed", async () => {
    const store = new RulesStore(db, { ttlMs: 0 });
    await store.boot();
    const next = await publish({ max_discount_pct: 12 }, MEERA_RULES_V3.rules_version + 1);
    await store.load();
    expect(store.version()).toBe(next.rules_version);
    expect(store.snapshot().max_discount_pct).toBe(12);
  });

  it("keeps the last GOOD config when a row fails schema validation", async () => {
    const store = new RulesStore(db, { ttlMs: 0 });
    await store.boot();
    // Hand-edited/corrupt row: must not hand the gatekeeper a half config.
    await db.query(
      `INSERT INTO merchant_rules (rules_version, rules_json, actor, note, increase)
       VALUES ($1, $2, 'test', 'corrupt', false)`,
      [MEERA_RULES_V3.rules_version + 1, JSON.stringify({ rules_version: 4, nonsense: true })],
    );
    const loaded = await store.load();
    expect(loaded.rules_version).toBe(MEERA_RULES_V3.rules_version);
    expect(loaded.max_discount_pct).toBe(MEERA_RULES_V3.max_discount_pct);
  });
});
