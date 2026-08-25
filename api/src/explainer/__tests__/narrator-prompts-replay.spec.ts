/**
 * Narration prompt construction: freeze discipline, canonical payload
 * stability (producer key-order cannot perturb the replay key), and the
 * stable-mode record/replay ports.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  NARRATOR_MODEL,
  SYSTEM_PROMPT,
  SYSTEM_PROMPT_HASH,
  buildRequestBody,
  buildUserPayload,
  requestBodyKey,
} from "../prompts.js";
import {
  RecordingNarratorPort,
  ReplayNarratorPort,
  StableModeCacheMissError,
} from "../replay.narrator.js";
import { ARGS, EVENTS, HONEST_OUTPUT, UNTRUSTED } from "./explainer-fixtures.js";

describe("frozen system prompt", () => {
  it("hash is a stable sha256 hex digest that recomputes", () => {
    expect(SYSTEM_PROMPT_HASH).toMatch(/^[0-9a-f]{64}$/);
    expect(createHash("sha256").update(SYSTEM_PROMPT).digest("hex")).toBe(
      SYSTEM_PROMPT_HASH,
    );
  });

  it("states both halves of the narration constraint verbatim-ish", () => {
    expect(SYSTEM_PROMPT).toContain("grounded_on_events");
    expect(SYSTEM_PROMPT).toContain("buyer claim —");
    expect(SYSTEM_PROMPT).toContain("Never cite a seq that was not provided");
    expect(SYSTEM_PROMPT).toContain("UNTRUSTED");
  });

  it("carries no fixture data (freeze discipline)", () => {
    expect(SYSTEM_PROMPT).not.toContain("EMPLOYEE50");
    expect(SYSTEM_PROMPT).not.toContain("MAX_DISCOUNT_PCT");
  });
});

describe("buildUserPayload determinism", () => {
  it("byte-equal across invocations", () => {
    const a = buildUserPayload(ARGS);
    const b = buildUserPayload({
      audience: ARGS.audience,
      events: [...EVENTS],
      untrustedTexts: [...UNTRUSTED],
    });
    expect(a).toBe(b);
  });

  it("event payloads ride through canonicalJson — producer key order is irrelevant", () => {
    // Same logical event, every key present, different key insertion order.
    const reordered = [
      {
        seq: 1,
        type: "gatekeeper_rule_result" as const,
        payload: {
          actual: "proposed 5000 bps",
          expected: "discount <= 1500 bps",
          rule_id: "MAX_DISCOUNT_PCT",
          severity: "BLOCKER",
          status: "FAIL",
        },
      },
      ...EVENTS.slice(1),
    ];
    expect(buildUserPayload({ ...ARGS, events: reordered })).toBe(
      buildUserPayload(ARGS),
    );
  });

  it("untrusted text rides behind the explicit delimiter", () => {
    const payload = buildUserPayload(ARGS);
    expect(payload).toContain('"untrusted_buyer_text"');
    expect(payload).toContain("EMPLOYEE50"); // present as delimited untrusted input
  });
});

describe("request body + replay key", () => {
  it("body deterministic; key its sha256 over canonical JSON; sensitive to edits", () => {
    const b1 = buildRequestBody(ARGS, NARRATOR_MODEL);
    const b2 = buildRequestBody(ARGS, NARRATOR_MODEL);
    expect(JSON.stringify(b1)).toBe(JSON.stringify(b2));
    const key = requestBodyKey(b1);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(requestBodyKey(buildRequestBody({ ...ARGS, audience: "AUDIT_TRAIL" }, NARRATOR_MODEL))).not.toBe(key);
    expect(requestBodyKey(buildRequestBody(ARGS, "meta/llama-3.1-8b-instruct"))).not.toBe(key);
  });
});

describe("stable-mode ports", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it("record → replay byte-equal; miss throws LOUDLY with the key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ga-narration-"));
    dirs.push(dir);
    const port = { narrate: async () => HONEST_OUTPUT };
    await new RecordingNarratorPort(port, dir).narrate(ARGS);

    const key = requestBodyKey(buildRequestBody(ARGS, NARRATOR_MODEL));
    const onDisk = JSON.parse(await readFile(`${dir}/${key}.json`, "utf8")) as unknown;
    expect(onDisk).toEqual(HONEST_OUTPUT);
    await expect(new ReplayNarratorPort(dir).narrate(ARGS)).resolves.toEqual(HONEST_OUTPUT);

    const otherArgs = { ...ARGS, audience: "APPROVAL_ASSIST" as const };
    const otherKey = requestBodyKey(buildRequestBody(otherArgs, NARRATOR_MODEL));
    try {
      await new ReplayNarratorPort(dir).narrate(otherArgs);
      expect.unreachable("expected miss");
    } catch (e) {
      expect(e).toBeInstanceOf(StableModeCacheMissError);
      expect((e as StableModeCacheMissError).key).toBe(otherKey);
      expect((e as Error).message).toContain(otherKey);
    }
  });
});
