/**
 * enrichCatalog — per-SKU isolation, the retry ladder (attempts=2, one
 * PARSE_FAILED re-request), and the degradation contract: every operational
 * failure lands UNENRICHED with error_detail while siblings sail through.
 */
import { describe, expect, it } from "vitest";
import { NimHttpError, NimNetworkError } from "../../llm/nim.js";
import type { EnrichmentOutput } from "@growthagent/shared";
import { enrichCatalog } from "../batch.js";
import type { CatalogItemInput } from "../prompts.js";
import type { EnrichmentPort } from "../enrichment.port.js";
import { EnrichmentParseError } from "../enrichment.port.js";
import {
  ALL_SKUS,
  ITEM_BSC,
  ITEM_MITHAI,
  ITEM_TIN,
  OUT_BSC,
  OUT_TIN,
} from "./catalog-fixtures.js";

const NO_SLEEP = { sleep: async () => {}, jitter: () => 0 };

/** Port whose nth call (per item) runs behavior(n). */
function scripted(
  behavior: (n: number) => Promise<EnrichmentOutput>,
): { readonly calls: () => number; readonly port: EnrichmentPort } {
  let calls = 0;
  return {
    calls: () => calls,
    port: {
      enrich: async () => {
        calls++;
        return behavior(calls);
      },
    },
  };
}

describe("enrichCatalog", () => {
  it("healthy batch → all ENRICHED with sanitized fields + model attribution", async () => {
    const port = {
      enrich: async ({ item }: { item: CatalogItemInput }) =>
        item.sku === ITEM_TIN.sku ? OUT_TIN : OUT_BSC,
    };
    const r = await enrichCatalog(port, [ITEM_TIN, ITEM_BSC], {
      allowedSkus: ALL_SKUS,
    }, NO_SLEEP);
    expect(r.telemetry).toMatchObject({
      live_calls: 2,
      parse_retries: 0,
      enriched_count: 2,
      unenriched_count: 0,
    });
    const tin = r.results[0]!;
    expect(tin.status).toBe("ENRICHED");
    expect(tin.updated_by_model).toBe("meta/llama-3.3-70b-instruct");
    expect(tin.fields?.occasions).toEqual(["diwali", "congrats"]);
    expect(tin.raw_response).toEqual(OUT_TIN);
    expect(tin.error_detail).toBeNull();
  });

  it("rogue-but-schema-valid output still ENRICHES — warnings ride along", async () => {
    const rogue = {
      ...OUT_TIN,
      occasions: ["diwali", "housewarming"],
      pairing_suggestions: ["SKU-GHOST"],
    };
    const r = await enrichCatalog({ enrich: async () => rogue }, [ITEM_TIN], {
      allowedSkus: ALL_SKUS,
    }, NO_SLEEP);
    const tin = r.results[0]!;
    expect(tin.status).toBe("ENRICHED");
    expect(tin.fields?.warnings).toContain("UNKNOWN_OCCASION:housewarming");
    expect(tin.fields?.warnings).toContain("PAIRING_NOT_IN_CATALOG:SKU-GHOST");
  });

  it("PARSE_FAILED consumes exactly one re-request then succeeds", async () => {
    const h = scripted(async (n) => {
      if (n === 1) throw new EnrichmentParseError();
      return OUT_TIN;
    });
    const r = await enrichCatalog(h.port, [ITEM_TIN], { allowedSkus: ALL_SKUS }, NO_SLEEP);
    expect(h.calls()).toBe(2);
    expect(r.results[0]?.status).toBe("ENRICHED");
    expect(r.telemetry.parse_retries).toBe(1);
  });

  it("transport failure → UNENRICHED with classified error_detail; raw fields kept", async () => {
    const h = scripted(async () => {
      throw new NimNetworkError("conn dead");
    });
    const r = await enrichCatalog(h.port, [ITEM_TIN], { allowedSkus: ALL_SKUS }, NO_SLEEP);
    expect(h.calls()).toBe(2); // ladder exhausted
    const tin = r.results[0]!;
    expect(tin.status).toBe("UNENRICHED");
    expect(tin.error_detail).toContain("RETRYABLE_EXHAUSTED");
    expect(tin.error_detail).toContain("conn dead");
    expect(tin.updated_by_model).toBeNull();
    expect(tin.raw_response).toBeNull();
    expect(r.telemetry.unenriched_count).toBe(1);
  });

  it("NON_RETRYABLE aborts that SKU immediately — sibling unaffected", async () => {
    let tinCalls = 0;
    let bscCalls = 0;
    const port = {
      enrich: async ({ item }: { item: CatalogItemInput }) => {
        if (item.sku === ITEM_TIN.sku) {
          tinCalls++;
          throw new NimHttpError(400, "bad");
        }
        bscCalls++;
        return OUT_BSC;
      },
    };
    const r = await enrichCatalog(port, [ITEM_TIN, ITEM_BSC], {
      allowedSkus: ALL_SKUS,
    }, NO_SLEEP);
    expect(tinCalls).toBe(1); // no retry on our-bug errors
    expect(bscCalls).toBe(1);
    expect(r.results.map((x) => x.status)).toEqual(["UNENRICHED", "ENRICHED"]);
    expect(r.telemetry).toMatchObject({
      enriched_count: 1,
      unenriched_count: 1,
      live_calls: 2,
    });
  });

  it("blank display name from a schema-valid model → UNENRICHED keeping raw_response", async () => {
    const r = await enrichCatalog(
      { enrich: async () => ({ ...OUT_TIN, display_name: "  " }) },
      [ITEM_MITHAI],
      { allowedSkus: ALL_SKUS },
      NO_SLEEP,
    );
    const row = r.results[0]!;
    expect(row.status).toBe("UNENRICHED");
    expect(row.error_detail).toBe("EMPTY_DISPLAY_NAME");
    expect(row.raw_response).not.toBeNull(); // debug artifact kept
  });

  it("backoff sleep fires between attempts with injectable timing", async () => {
    const sleeps: number[] = [];
    const t = { sleep: async (ms: number) => void sleeps.push(ms), jitter: () => 0.5 };
    const h = scripted(async () => {
      throw new NimHttpError(500, "down");
    });
    await enrichCatalog(h.port, [ITEM_TIN], { allowedSkus: ALL_SKUS }, t);
    // 500·2^0 + floor(0.5·100) = 550
    expect(sleeps).toEqual([550]);
  });
});
