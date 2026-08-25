/**
 * DEMO_STABLE_MODE (negotiation.md §7 + §8.2): fixture-key reproducibility,
 * loud cache-miss, schema-drift invalidation, round-trip replay.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalJson } from "@growthagent/shared";
import { systemPromptHash } from "../prompt.js";
import {
  ReplayTransport,
  StableModeCacheMissError,
  negotiationFixtureKey,
} from "../transport.replay.js";
import type { TransportKeyInputs } from "../transport.types.js";
import type { RenderedRequest } from "../prompt.js";
import { cleanProposal, mkPack } from "./fixtures.js";

let dir: string;

let fxDir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "ga-fixtures-"));
  fxDir = path.join(dir, "negotiations"); // fixturesDir IS the negotiations dir
  mkdirSync(fxDir, { recursive: true });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const keyInputs = (): TransportKeyInputs => ({
  system_prompt_hash: systemPromptHash(),
  pack_hash: mkPack().pack_hash,
  buyer_request_canonical: canonicalJson({ items: [{ sku: "CAKE-CHOC-500", qty: 1 }], channel: "AGENT" }),
});

const fakeRendered = (): RenderedRequest => ({
  system_blocks: [],
  messages: [],
  params: { model: "meta/llama-3.3-70b-instruct", max_tokens: 8000 },
});

function writeFixture(key: string, body: unknown): void {
  writeFileSync(path.join(fxDir, `${key}.json`), JSON.stringify(body), "utf8");
}

const fixtureBody = () => ({
  key: "",
  request_snapshot: { note: "recorded by demo:record" },
  raw_text: "{...}",
  thinking_summary: "brief",
  parsed_output: cleanProposal(),
  usage: { input_tokens: 1000, output_tokens: 300, cache_read_input_tokens: undefined },
  stop_reason: "end_turn",
  latency_ms: 1234,
});

describe("negotiationFixtureKey", () => {
  it("is reproducible for identical inputs", () => {
    expect(negotiationFixtureKey(keyInputs())).toBe(negotiationFixtureKey(keyInputs()));
  });

  it("moves when ANY component moves", () => {
    const base = negotiationFixtureKey(keyInputs());
    expect(
      negotiationFixtureKey({ ...keyInputs(), pack_hash: "0".repeat(64) }),
    ).not.toBe(base);
    expect(
      negotiationFixtureKey({ ...keyInputs(), buyer_request_canonical: "{}" }),
    ).not.toBe(base);
    expect(
      negotiationFixtureKey({ ...keyInputs(), system_prompt_hash: "f".repeat(64) }),
    ).not.toBe(base);
  });

  it("defaults an empty system_prompt_hash to the frozen V3 prompt hash", () => {
    expect(
      negotiationFixtureKey({ ...keyInputs(), system_prompt_hash: "" }),
    ).toBe(negotiationFixtureKey(keyInputs()));
  });
});

describe("ReplayTransport", () => {
  it("MISSING fixture throws StableModeCacheMissError naming the key — never falls back to live", async () => {
    const t = new ReplayTransport({ fixturesDir: fxDir });
    const k = keyInputs();
    await expect(t.execute(fakeRendered(), k)).rejects.toThrow(StableModeCacheMissError);
    await expect(t.execute(fakeRendered(), k)).rejects.toMatchObject({
      key: negotiationFixtureKey(k),
    });
  });

  it("HIT replays the recorded proposal byte-faithfully with a synthetic attempt log", async () => {
    const k = keyInputs();
    const key = negotiationFixtureKey(k);
    const body = { ...fixtureBody(), key };
    writeFixture(key, body);

    const res = await new ReplayTransport({ fixturesDir: fxDir }).execute(fakeRendered(), k);
    expect(res.parsed_output).toEqual(cleanProposal());
    expect(res.stop_reason).toBe("end_turn");
    expect(res.latency_ms).toBe(1234);
    expect(res.attempts).toHaveLength(1);
    expect(res.attempts[0]?.kind).toBe("initial");
  });

  it("a stored proposal that fails CURRENT schema invalidates the fixture loudly", async () => {
    const k = keyInputs();
    const key = negotiationFixtureKey(k);
    const stale = {
      ...fixtureBody(),
      parsed_output: {
        ...cleanProposal(),
        proposed_items: [{ sku: "not-a-valid-sku!!", qty: 1 }],
      },
    };
    writeFixture(key, stale);
    await expect(
      new ReplayTransport({ fixturesDir: fxDir }).execute(fakeRendered(), k),
    ).rejects.toThrow(/failed current schema/u);
  });

  it("unreadable/corrupt fixture JSON is a miss, not a crash", async () => {
    const k = keyInputs();
    writeFileSync(
      path.join(fxDir, `${negotiationFixtureKey(k)}.json`),
      "{not json",
      "utf8",
    );
    await expect(
      new ReplayTransport({ fixturesDir: fxDir }).execute(fakeRendered(), k),
    ).rejects.toThrow(StableModeCacheMissError);
  });
});
