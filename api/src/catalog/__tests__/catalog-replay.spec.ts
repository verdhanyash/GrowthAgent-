/**
 * DEMO_STABLE_MODE for enrichment: record round-trip, byte-equal hit, LOUD
 * miss, corrupt fixture, key sensitivity.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RecordingEnrichmentPort,
  ReplayEnrichmentPort,
  StableModeCacheMissError,
} from "../replay.enrichment.js";
import { buildRequestBody, requestBodyKey } from "../prompts.js";
import { ALL_SKUS, ITEM_TIN, OUT_TIN } from "./catalog-fixtures.js";

const ARGS = { item: ITEM_TIN, allowedSkus: ALL_SKUS };

const dirs: string[] = [];
async function freshDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "ga-enrichment-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const OK_PORT = { enrich: async () => OUT_TIN };
const keyOf = (args: typeof ARGS): string =>
  requestBodyKey(buildRequestBody(args, "meta/llama-3.3-70b-instruct"));

describe("enrichment stable-mode ports", () => {
  it("recording persists under <dir>/<key>.json and passes through", async () => {
    const dir = await freshDir();
    const out = await new RecordingEnrichmentPort(OK_PORT, dir).enrich(ARGS);
    expect(out).toEqual(OUT_TIN);
    const onDisk = JSON.parse(
      await readFile(`${dir}/${keyOf(ARGS)}.json`, "utf8"),
    ) as unknown;
    expect(onDisk).toEqual(OUT_TIN);
  });

  it("hit replays byte-equal; miss throws LOUDLY with the key", async () => {
    const dir = await freshDir();
    await new RecordingEnrichmentPort(OK_PORT, dir).enrich(ARGS);
    await expect(new ReplayEnrichmentPort(dir).enrich(ARGS)).resolves.toEqual(OUT_TIN);

    const other = { item: ITEM_TIN, allowedSkus: [ITEM_TIN.sku] };
    try {
      await new ReplayEnrichmentPort(dir).enrich(other);
      expect.unreachable("expected miss");
    } catch (e) {
      expect(e).toBeInstanceOf(StableModeCacheMissError);
      expect((e as StableModeCacheMissError).key).toBe(keyOf(other));
      expect((e as Error).message).toContain(keyOf(other));
    }
  });

  it("corrupt fixture surfaces a parse error, not a fake hit", async () => {
    const dir = await freshDir();
    await new RecordingEnrichmentPort(OK_PORT, dir).enrich(ARGS);
    await writeFile(`${dir}/${keyOf(ARGS)}.json`, "{ not json", "utf8");
    await expect(new ReplayEnrichmentPort(dir).enrich(ARGS)).rejects.toThrow();
  });
});
