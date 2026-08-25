/**
 * DEMO_STABLE_MODE record/replay ports (campaign.md §7.3 tail, I-9 unit
 * half). Loud cache-miss contract; key stability/sensitivity; recording
 * round-trip through the shared request-hash key.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assembleEntries } from "../domain/derive.js";
import {
  RecordingRationalePort,
  ReplayRationalePort,
  StableModeCacheMissError,
} from "../llm/replay.rationale.js";
import { requestBodyKey, buildRequestBody } from "../llm/prompts.js";
import {
  ALL_OPPS,
  DRAFT_ARGS as ARGS,
  HONEST_RATIONALES,
} from "./campaign-fixtures.js";

const dirs: string[] = [];
async function freshDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "ga-rationales-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const OUT = {
  rationales: ALL_OPPS.map((o, i) => ({
    entry_index: i,
    rationale_nl: HONEST_RATIONALES[o.type],
  })),
};

const OK_PORT = { draft: async () => OUT };

describe("recording port", () => {
  it("persists parsed output under <dir>/<key>.json and passes it through", async () => {
    const dir = await freshDir();
    const recorded = await new RecordingRationalePort(OK_PORT, dir).draft(ARGS);
    expect(recorded).toEqual(OUT);

    const key = requestBodyKey(buildRequestBody(ARGS, "meta/llama-3.3-70b-instruct"));
    const onDisk = JSON.parse(
      await readFile(`${dir}/${key}.json`, "utf8"),
    ) as unknown;
    expect(onDisk).toEqual(OUT);
  });
});

describe("replay port", () => {
  it("hit returns the recorded output byte-equal (I-9 prerequisite)", async () => {
    const dir = await freshDir();
    await new RecordingRationalePort(OK_PORT, dir).draft(ARGS);
    const replayed = await new ReplayRationalePort(dir).draft(ARGS);
    expect(JSON.stringify(replayed)).toBe(JSON.stringify(OUT));
  });

  it("miss throws LOUDLY with the key — never a silent live call", async () => {
    const dir = await freshDir();
    try {
      await new ReplayRationalePort(dir).draft(ARGS);
      expect.unreachable("expected StableModeCacheMissError");
    } catch (e) {
      expect(e).toBeInstanceOf(StableModeCacheMissError);
      const key = requestBodyKey(buildRequestBody(ARGS, "meta/llama-3.3-70b-instruct"));
      expect((e as StableModeCacheMissError).key).toBe(key);
      expect((e as Error).message).toContain(key);
    }
  });

  it("corrupt fixture surfaces a parse error, not a fake hit", async () => {
    const dir = await freshDir();
    const key = requestBodyKey(buildRequestBody(ARGS, "meta/llama-3.3-70b-instruct"));
    await new RecordingRationalePort(OK_PORT, dir).draft(ARGS);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(`${dir}/${key}.json`, "{ not json", "utf8");
    await expect(new ReplayRationalePort(dir).draft(ARGS)).rejects.toThrow();
  });

  it("key sensitivity: edited entries force exactly one live re-record", async () => {
    const dir = await freshDir();
    await new RecordingRationalePort(OK_PORT, dir).draft(ARGS);
    // Same data replays:
    await expect(new ReplayRationalePort(dir).draft(ARGS)).resolves.toEqual(OUT);
    // Edited seed data → different key → loud miss:
    const edited = assembleEntries([ALL_OPPS[0]!]);
    try {
      await new ReplayRationalePort(dir).draft({
        entries: edited.entries,
        metricsByEntry: [ALL_OPPS[0]!.metrics],
      });
      expect.unreachable("expected miss");
    } catch (e) {
      expect(e).toBeInstanceOf(StableModeCacheMissError);
    }
  });

  it("schema validation rejects structurally wrong fixtures on replay", async () => {
    const dir = await freshDir();
    const bad = new RecordingRationalePort(
      { draft: async () => ({ rationales: [{ entry_index: -1, rationale_nl: "x".repeat(50) }] }) },
      dir,
    );
    // Recording itself doesn't validate (it stores what the LLM returned)…
    await bad.draft(ARGS);
    // …but replay parses through RationalesOutputZ and must reject.
    await expect(new ReplayRationalePort(dir).draft(ARGS)).rejects.toThrow();
  });
});
