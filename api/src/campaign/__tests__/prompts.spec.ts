/**
 * Prompt construction (campaign.md §7.2): frozen system prompt, byte-stable
 * volatile payload (U-14 — the prerequisite for caching + replay keys), and
 * id-free entry lines (index-addressing).
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SYSTEM_PROMPT,
  SYSTEM_PROMPT_HASH,
  buildRequestBody,
  buildUserPayload,
  requestBodyKey,
} from "../llm/prompts.js";
import { ASSEMBLY, DRAFT_ARGS as ARGS } from "./campaign-fixtures.js";

const assembly = ASSEMBLY;

describe("frozen system prompt", () => {
  it("hash is a stable sha256 hex digest", () => {
    expect(SYSTEM_PROMPT_HASH).toMatch(/^[0-9a-f]{64}$/);
    expect(
      createHash("sha256").update(SYSTEM_PROMPT).digest("hex"),
    ).toBe(SYSTEM_PROMPT_HASH);
  });

  it("carries no run data and no counters (freeze discipline)", () => {
    // The single sanctioned date is rule 4's format exemplar; anything else
    // datelike or fixture-specific would break byte-stability across runs.
    const dates = SYSTEM_PROMPT.match(/20\d\d-\d\d-\d\d/g) ?? [];
    expect(dates).toEqual(["2026-08-29"]);
    expect(SYSTEM_PROMPT.toLowerCase()).not.toContain("mango");
    expect(SYSTEM_PROMPT.toLowerCase()).not.toContain("kaju");
    expect(SYSTEM_PROMPT.toLowerCase()).not.toContain("run ");
  });

  it("states the quoting contract and index-addressed role", () => {
    expect(SYSTEM_PROMPT).toContain("EXACTLY as given");
    expect(SYSTEM_PROMPT).toContain("audit trail");
    expect(SYSTEM_PROMPT).toContain("Do not introduce ANY number");
  });
});

describe("buildUserPayload (U-14)", () => {
  it("byte-equal across invocations", () => {
    const a = buildUserPayload(ARGS);
    const b = buildUserPayload({ ...ARGS, entries: [...ARGS.entries] });
    expect(a).toBe(b);
  });

  it("lines carry index + facts ONLY — no ids the model could echo wrongly", () => {
    const payload = buildUserPayload(ARGS);
    expect(payload).toContain('"entry_index": 0');
    expect(payload).toContain('"action"');
    expect(payload).not.toContain("entry_id");
    expect(payload).not.toContain("opportunity_id");
    expect(payload).not.toContain(assembly.entries[0]!.entry_id);
  });

  it("metric displays ride verbatim (the verifier will demand them)", () => {
    const payload = buildUserPayload(ARGS);
    expect(payload).toContain("0.46x");
    expect(payload).toContain("2026-08-29"); // expiry display
    expect(payload).toContain("Sundays");
  });
});

describe("request body + replay key", () => {
  it("body is deterministic; key is its sha256 over canonical JSON", () => {
    const body1 = buildRequestBody(ARGS, "claude-opus-5");
    const body2 = buildRequestBody(ARGS, "claude-opus-5");
    expect(JSON.stringify(body1)).toBe(JSON.stringify(body2));
    expect(requestBodyKey(body1)).toMatch(/^[0-9a-f]{64}$/);
    expect(requestBodyKey(body1)).toBe(requestBodyKey(body2));
  });

  it("key is sensitive to payload and model changes", () => {
    const body = buildRequestBody(ARGS, "claude-opus-5");
    const base = requestBodyKey(body);
    // Spread keeps the literal body shape (a JSON.parse cast would widen it).
    const edited = {
      ...body,
      user_payload: body.user_payload.replace("0.46x", "9.99x"),
    };
    expect(requestBodyKey(edited)).not.toBe(base);
    expect(
      requestBodyKey(buildRequestBody(ARGS, "claude-opus-4")),
    ).not.toBe(base);
  });
});
