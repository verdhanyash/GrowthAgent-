/**
 * Rationale prompt construction (campaign.md §7.2). The system prompt is
 * FROZEN — byte-stable across runs, no dates/data/counters — and its sha256
 * rides in provenance + the replay key. The volatile user payload is built by
 * a pure function whose output is byte-equal across invocations for the same
 * inputs (U-14): that byte-stability is the prerequisite for both prompt
 * caching and DEMO_STABLE_MODE request hashing.
 *
 * Entries reach the model as INDEX + FACTS ONLY — no ids the model could echo
 * wrongly (index-addressing makes decision drift structurally impossible).
 */
import { createHash } from "node:crypto";
import type { Metric } from "@growthagent/shared";
import { canonicalJson } from "@growthagent/shared";
import type { EntryDraft } from "../domain/derive.js";

export const SYSTEM_PROMPT = `You are the campaign strategist for Meera's Cakes, a home bakery.
You receive a numbered list of campaign entries. Each entry already HAS a decision
(action, SKUs, weight) computed by deterministic analytics. Your ONLY job is to write
the human-readable rationale for the audit trail.

Rules:
1. For EVERY entry, write exactly one rationale of 1-3 sentences, plain English.
2. You MUST quote every provided metric value EXACTLY as given, including the symbol
   and unit suffix (₹, x, %, units, days, weeks). Do not round, convert, reformat,
   or derive new numbers. "0.46x" must appear as "0.46x", never "46%" or "about half".
3. Do not introduce ANY number that is not in the entry's metrics. No invented
   percentages, prices, dates, or counts.
4. State the action, name the SKUs, cite the metrics, and finish with the business
   consequence ("bundle it with...", "clear before 2026-08-29").
5. No markdown, no bullet lists, no headings, no preamble. Output only the JSON object
   the format requires.`;

export const SYSTEM_PROMPT_HASH = createHash("sha256")
  .update(SYSTEM_PROMPT)
  .digest("hex");

export interface DraftArgs {
  readonly entries: readonly EntryDraft[];
  /** metricsByEntry[i] = the Opportunity.metrics backing entries[i]. */
  readonly metricsByEntry: readonly (readonly Metric[])[];
}

/** Deterministic serialization of the volatile user turn. */
export function buildUserPayload(args: DraftArgs): string {
  const lines = args.entries.map((e, i) => ({
    entry_index: i,
    action: e.action,
    skus: [...e.skus],
    weight: e.weight,
    metrics: args.metricsByEntry[i]?.map((m) => ({ ...m })) ?? [],
  }));
  return JSON.stringify({ entries: lines }, null, 2);
}

/**
 * Canonical request body — THE replay/recording key input. Deliberately
 * excludes everything volatile (latency, usage, cache state); includes the
 * system-prompt hash so a prompt edit forces exactly one re-record, mirroring
 * the negotiation transport's freeze discipline.
 */
export function buildRequestBody(args: DraftArgs, model: string): {
  model: string;
  system_prompt_hash: string;
  max_tokens: number;
  user_payload: string;
} {
  return {
    model,
    system_prompt_hash: SYSTEM_PROMPT_HASH,
    max_tokens: 4096,
    user_payload: buildUserPayload(args),
  };
}

export const requestBodyKey = (body: {
  model: string;
  system_prompt_hash: string;
  max_tokens: number;
  user_payload: string;
}): string =>
  createHash("sha256").update(canonicalJson(body)).digest("hex");
